import type { MonitorIssue, Prisma, WorkItem } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import type { GitProviderId, ReleaseContainment } from '@/lib/git/types';
import { getMonitorProvider } from '@/lib/monitors';
import { isStillAsFiled } from '@/lib/monitors/asFiled';
import {
  MonitorBinderUnavailableError,
  MonitorFilingRaceError,
  MonitorProviderCallError,
} from '@/lib/monitors/errors';
import { meetsMinimumLevel } from '@/lib/monitors/levels';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { MONITOR_ISSUES_PAGE_LIMIT } from '@/lib/monitors/provider';
import type { NormalizedMonitorIssue, NormalizedMonitorIssuePage } from '@/lib/monitors/types';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  monitorIssueRepository,
  type MonitorIssueFacts,
} from '@/lib/repositories/monitorIssueRepository';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import {
  contextFactsOf,
  MONITOR_CONTEXT_SKIPPED,
  writeLinkContext,
  writeLinkFacts,
  type MonitorContextRead,
} from '@/lib/services/monitorContextRead';
import {
  monitorCredentialService,
  type MonitorAccessToken,
} from '@/lib/services/monitorCredentialService';
import { monitorSyncService } from '@/lib/services/monitorSyncService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DuplicateLinkError } from '@/lib/workItems/linkErrors';
import { relationshipToLink } from '@/lib/workItems/linkRelationships';
import { ReporterNotInWorkspaceError } from '@/lib/workItems/errors';
import {
  bindWorkspaceContext,
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// The monitor-issue INGESTION service (Story MOTIR-4929) — the reconciler that
// turns a production error into a `bug` work item and keeps it in agreement with
// the monitor.
//
// This file is the ONLY place a monitor issue files, updates or re-files a bug.
// `reconcileIssue` (MOTIR-5578) decides for ONE issue; the poll (MOTIR-5580)
// decides which issues reach it.
//
// ⚠️ IT IS A RECONCILER, NOT AN IMPORT. It brings Motir into agreement with the
// provider's issue as it stands now, so a first sighting, a recurrence, a
// back-fill after an outage and a re-run are all the same code path — keyed on
// the provider's own ISSUE id, which the `monitor_issue` row's unique index
// makes a database fact rather than a read.

/** The create path's title limit. `workItemsService.createWorkItem` enforces
 *  none itself; every interactive creator caps at 200 (`app/(authed)/items/
 *  actions.ts` `MAX_TITLE_LENGTH`, `CreateIssueModal`), so a filed bug is held
 *  to the same bound a person is. */
export const MONITOR_BUG_TITLE_MAX_LENGTH = 200;

/** What one reconcile did. */
export type MonitorReconcileOutcome = 'filed' | 'updated' | 'refiled';

export interface MonitorReconcileResult {
  outcome: MonitorReconcileOutcome;
  /** The bug the issue now points at. */
  workItemId: string;
  identifier: string;
}

/** The binding a reconcile runs for — the columns it reads, and no more. */
export interface MonitorReconcileConnection {
  id: string;
  projectId: string;
  workspaceId: string;
  /** Whose identity files the bug. `null` ⇒ {@link MonitorBinderUnavailableError}. */
  boundByUserId: string | null;
  /** The monitored project's slug, named in the bug body. */
  externalProjectSlug: string;
}

/** Why a bug is being filed AGAIN for an issue that already had one. */
interface PreviousBug {
  identifier: string;
  /** Present when the previous bug still exists (it was completed). */
  workItemId: string | null;
  reason: 'deleted' | 'completed';
}

const BINDER_MISSING =
  'This connection has no binder on record, so its bugs have no one to be filed as. ' +
  'Disconnect it and bind the monitored project again.';

const BINDER_CANNOT_FILE =
  'The person who bound this connection can no longer create work items in this project. ' +
  'Bind the monitored project again as someone who can.';

/**
 * The facts a visit writes. The latest event's environment and release
 * (MOTIR-5729) ride on a `read`, and a `failed` read stamps only the evidence's
 * last check (MOTIR-5979) — `contextFactsOf` decides, so a read that was never
 * made (`null` / `skipped`) leaves every context column standing. The EVIDENCE
 * itself is written beside these facts by `writeLinkFacts`, never through them.
 */
function factsOf(
  issue: NormalizedMonitorIssue,
  read: MonitorContextRead | null,
): MonitorIssueFacts {
  return {
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    permalink: issue.permalink,
    eventCount: issue.eventCount,
    firstSeenAt: issue.firstSeenAt,
    lastSeenAt: issue.lastSeenAt,
    ...contextFactsOf(read ?? MONITOR_CONTEXT_SKIPPED),
  };
}

/** The issue's own title, held to the create path's bound. */
export function monitorBugTitle(title: string): string {
  const trimmed = title.trim() || 'Untitled monitor issue';
  return trimmed.length <= MONITOR_BUG_TITLE_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MONITOR_BUG_TITLE_MAX_LENGTH - 1)}…`;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The THIN body, written once at filing and never rewritten: the error's own
 * words and where to see it. Making the bug PLANNED — both content axes, a
 * sizing, context refs — is MOTIR-4930's job, not this one's.
 */
export function monitorBugBody(
  issue: NormalizedMonitorIssue,
  externalProjectSlug: string,
  previous: PreviousBug | null,
): string {
  const lines: string[] = [];
  const culprit = issue.culprit ? `\`${issue.culprit}\`` : 'An unknown location';
  lines.push(`${culprit} · level \`${issue.level ?? 'unknown'}\``);
  lines.push(
    `Seen ${issue.eventCount} ${issue.eventCount === 1 ? 'time' : 'times'}, ` +
      `first ${day(issue.firstSeenAt)}, last ${day(issue.lastSeenAt)}.`,
  );
  const source = `monitored project \`${externalProjectSlug}\``;
  lines.push(
    issue.permalink ? `[Open the issue](${issue.permalink}) in ${source}.` : `From ${source}.`,
  );
  if (previous) {
    lines.push(
      previous.reason === 'deleted'
        ? `Filed again: the earlier bug ${previous.identifier} was deleted.`
        : `Filed again: the earlier bug ${previous.identifier} was completed, and the error has recurred since.`,
    );
  }
  return lines.join('\n\n');
}

/** Is this refusal the create path telling us the BINDER cannot file here? */
function isBinderRefusal(err: unknown): boolean {
  return (
    err instanceof ReporterNotInWorkspaceError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof ProjectNotFoundError
  );
}

/**
 * The most pages ONE poll reads before it stops and says so.
 *
 * A bound, not a budget: a connection that has accumulated more than this many
 * pages of issues since its last check (a first poll on a noisy organisation, or
 * the back-fill after a long outage) records a FAILED outcome naming the count
 * and does NOT advance its watermark — loud, rather than silently reconciling a
 * truncated prefix and moving on as if it had seen everything. Raising the
 * connection's minimum level is the lever a person has.
 */
export const MONITOR_POLL_MAX_PAGES = 20;

/**
 * The most CONTEXT reads (an issue's latest event — its environment and release)
 * ONE poll makes for ONE connection (Story MOTIR-4932 · Subtask MOTIR-5729).
 *
 * ⚠️ THE COST IS ONE PROVIDER REQUEST PER ISSUE VISITED: the issue list carries
 * neither fact, and the only documented read that does is addressed by one issue
 * (`MonitorProvider.getIssueContext`). So a noisy poll is capped here; an issue
 * past the cap reconciles exactly as it always has and its context is refreshed
 * on a later visit. An ENRICHMENT, never a gate on filing.
 */
export const MONITOR_CONTEXT_READS_PER_POLL = 50;

/**
 * The most ENRICHMENT BACKFILLS one poll requests (Story MOTIR-5975 · Subtask
 * MOTIR-5983): monitor-filed bugs the `work-item/created` enrichment never
 * reached, each of which costs one `author_bug` model call. A few at a time, on
 * the poll that already runs every half hour, so a backlog of old bugs can never
 * spend the AI budget in one burst.
 */
export const MONITOR_ENRICHMENT_BACKFILL_PER_POLL = 10;

/**
 * How old a filed bug must be before the backfill sweep may offer it enrichment
 * (MOTIR-5983). ⚠️ THIS IS WHAT KEEPS THE TWO TRIGGERS FROM RACING. A bug filed by
 * THIS poll has its own `work-item/created` enrichment in flight, and
 * `dispatchEnrichment` reads the link's `authoringJobId`, submits, then writes it —
 * so a second trigger arriving inside that window could submit a second
 * `author_bug`. The created-trigger's whole bounded life (five attempts, then a
 * five-minute wait) is far inside an hour, so the sweep reaches only the bugs that
 * trigger never finished: the ones filed before it shipped, and the ones whose
 * run dead-lettered.
 */
export const MONITOR_ENRICHMENT_BACKFILL_GRACE_MS = 60 * 60 * 1000;

/** What one poll did — the per-connection run's ledger output. */
export interface MonitorPollSummary {
  status: 'ok' | 'failed';
  filed: number;
  updated: number;
  refiled: number;
  /** Issues below the connection's minimum level: counted, never reconciled. */
  skipped: number;
  /**
   * Issues below the minimum level that a person LINKED to a live work item —
   * their facts refreshed, nothing filed (MOTIR-5729). Counted apart so `filed`
   * keeps its meaning.
   */
  refreshed: number;
  pages: number;
  /** Never-read links whose evidence the standing sweep read and stored this
   *  poll, from the context-read budget the page walk left (MOTIR-5983). */
  evidenceBackfilled: number;
  /** Monitor-filed bugs the sweep asked the enrichment to author (MOTIR-5983). */
  enrichmentRequested: number;
}

/** A poll that never started: the connection is gone (deleted between the tick
 *  and this run). Nothing to record ON, so it is reported as a no-op. */
const NOTHING_POLLED: MonitorPollSummary = {
  status: 'ok',
  filed: 0,
  updated: 0,
  refiled: 0,
  skipped: 0,
  refreshed: 0,
  pages: 0,
  evidenceBackfilled: 0,
  enrichmentRequested: 0,
};

/**
 * Read ONE issue's latest-event context with the credential the poll ALREADY
 * holds — never inside a transaction, never with a refresh of its own.
 *
 * ⚠️ EVERY FAILURE IS ABSORBED, AND THAT IS THE RULE, NOT A SHORTCUT: a refusal,
 * a timeout and a gone issue all answer `failed`, which leaves the stored
 * environment, release and evidence exactly as they were and records only WHEN
 * the check failed — what makes the evidence read as stale (MOTIR-5979). Filing must not become less
 * reliable because an enrichment failed (MOTIR-5729; the degrade principle
 * MOTIR-4930 states for the bug body). It deliberately does not go through
 * `withFreshCredential`, so an enrichment's 401 can never be the thing that
 * marks a working connection `degraded` — the listing that just succeeded with
 * this credential is the health signal.
 */
async function readContextQuietly(
  credential: MonitorAccessToken,
  externalIssueId: string,
): Promise<MonitorContextRead> {
  try {
    const context = await getMonitorProvider(credential.provider).getIssueContext({
      accessToken: credential.token,
      orgSlug: credential.orgSlug ?? '',
      externalIssueId,
    });
    return { outcome: 'read', context, at: new Date() };
  } catch {
    return { outcome: 'failed', at: new Date() };
  }
}

/**
 * Whether the release an issue's latest event came from carries the merge that
 * COMPLETED its linked bug (Bug MOTIR-8330) — the read {@link reconcileIssue}
 * consults before it re-files a done bug.
 *
 * `missing` means an event from a build that predates the fix: the old release
 * still serving in the window between the merge and its deploy. It is the ONLY
 * answer that changes a decision; `contains` and `unknown` re-file as before.
 */
export interface MonitorFixReleaseRead {
  /** The bug the answer is about — the reconcile acts on it only if the link still
   *  points there under its row lock. */
  workItemId: string;
  /** The commit the latest event's release named. */
  release: string;
  containment: ReleaseContainment;
}

/** A release that names a commit: a bare sha, or `<name>@<sha>`. Anything else
 *  (a semver, a build number) is not a commit a host can place. */
const RELEASE_COMMIT = /^[0-9a-f]{7,40}$/i;

export function releaseCommitOf(release: string | null): string | null {
  if (!release) return null;
  const candidate = release.slice(release.lastIndexOf('@') + 1).trim();
  return RELEASE_COMMIT.test(candidate) ? candidate : null;
}

/**
 * Read {@link MonitorFixReleaseRead} for one issue — OUTSIDE any row lock, like the
 * context read it builds on, because it is up to two host calls per merged pull
 * request.
 *
 * `null` — the answer the reconcile reads as "nothing known", and re-files on —
 * whenever there is nothing to ask: no context read this visit (an event with no
 * release is the card's own carve-out), a release that names no commit, an issue
 * with no linked bug, a bug that is not done, or a done bug with no MERGED
 * delivery (completed by hand or by an approval).
 *
 * ⚠️ ONE MERGE THE RELEASE LACKS IS ENOUGH TO HOLD. A bug delivered by several pull
 * requests is fixed in production only once the release carries all of them, so a
 * single `missing` answers `missing`; every member `contains` answers `contains`,
 * and anything in between is `unknown`. A pull request in a repository the release
 * is not built from answers `unknown` (the host does not know the commit), which
 * is why one is not enough to call the whole set `contains`.
 *
 * ⚠️ IT NEVER THROWS. The host's own failures are `unknown` by the seam's contract;
 * a failure here (an unregistered provider, a store read) is caught and read as
 * `null`, so a poll never loses an issue to this courtesy read.
 */
async function readFixReleaseQuietly(
  connection: MonitorReconcileConnection,
  issue: NormalizedMonitorIssue,
  read: MonitorContextRead,
  doneKeys: () => Promise<ReadonlySet<string>>,
): Promise<MonitorFixReleaseRead | null> {
  if (read.outcome !== 'read') return null;
  const release = releaseCommitOf(read.context.release);
  if (!release) return null;
  try {
    const done = await doneKeys();
    const linked = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, connection.workspaceId);
      const [link] = await monitorIssueRepository.listLinkedByExternalIds(
        connection.id,
        [issue.externalId],
        tx,
      );
      if (!link) return null;
      const bug = await workItemRepository.findById(link.workItemId, tx);
      if (!bug || !done.has(bug.status)) return null;
      const merged = await workItemDeliveryRepository.listMergedHostAddressesByWorkItem(bug.id, tx);
      return { workItemId: bug.id, merged };
    });
    if (!linked || linked.merged.length === 0) return null;

    const answers: ReleaseContainment[] = [];
    for (const address of linked.merged) {
      const provider = getGitProvider(address.provider as GitProviderId);
      answers.push(
        provider.readReleaseContainsMerge
          ? await provider.readReleaseContainsMerge({
              installationId: address.hostInstallationId,
              owner: address.owner,
              name: address.name,
              number: address.number,
              release,
            })
          : 'unknown',
      );
    }
    const containment: ReleaseContainment = answers.includes('missing')
      ? 'missing'
      : answers.every((answer) => answer === 'contains')
        ? 'contains'
        : 'unknown';
    return { workItemId: linked.workItemId, release, containment };
  } catch (err) {
    console.warn('[monitor-ingestion] fix-release read failed; re-filing as before', {
      connectionId: connection.id,
      externalIssueId: issue.externalId,
      err,
    });
    return null;
  }
}

/**
 * THE STANDING BACKFILL SWEEP (Story MOTIR-5975 · Subtask MOTIR-5983), run at the
 * end of every poll whose listing succeeded, AFTER the page walk's writes have
 * committed. It reaches the two populations nothing else revisits:
 *
 * (a) EVIDENCE — links to a live work item whose latest event was never read.
 *     The poll lists only issues seen since its watermark, so an issue that has
 *     not recurred is never visited again. Read with the poll's OWN credential,
 *     from the context-read budget the page walk left, each outside any lock and
 *     written under the row lock through the same three-outcome path.
 * (b) ENRICHMENT — bugs the reconciler filed that were never offered
 *     `author_bug` (filed before the enrichment shipped, which rides only
 *     `work-item/created`). Up to {@link MONITOR_ENRICHMENT_BACKFILL_PER_POLL}
 *     are emitted as `monitor-issue/enrichment-backfill`, after the read that
 *     chose them has committed.
 *
 * It CONVERGES: once every link is read and every eligible bug offered, both
 * queries return nothing. And it is QUIET: a failure here is logged and left for
 * the next poll, and never changes what the poll records — the sweep is an
 * enrichment of the reconcile, never a gate on it.
 */
async function sweepBackfill(
  connection: {
    id: string;
    projectId: string;
    workspaceId: string;
    boundByUserId: string | null;
  },
  credential: MonitorAccessToken | null,
  remainingReads: number,
  pollStartedAt: Date,
): Promise<{ evidenceBackfilled: number; enrichmentRequested: number }> {
  const done = { evidenceBackfilled: 0, enrichmentRequested: 0 };
  try {
    const doneKeys = [...(await doneKeysOf(connection.projectId, connection.workspaceId))];

    // ── (a) EVIDENCE ─────────────────────────────────────────────────────────
    if (credential && remainingReads > 0) {
      const neverRead = await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, connection.workspaceId);
        return monitorIssueRepository.listNeverReadLinked(
          connection.id,
          doneKeys,
          pollStartedAt,
          remainingReads,
          tx,
        );
      });
      for (const link of neverRead) {
        const read = await readContextQuietly(credential, link.externalIssueId);
        const wrote = await withSystemContext(async (tx) => {
          await bindWorkspaceContext(tx, connection.workspaceId);
          const row = await monitorIssueRepository.lockById(link.id, tx);
          if (!row) return false;
          return writeLinkContext(row.id, read, tx);
        });
        if (wrote) done.evidenceBackfilled += 1;
      }
    }

    // ── (b) ENRICHMENT ───────────────────────────────────────────────────────
    const binderId = connection.boundByUserId;
    if (binderId) {
      const eligible = await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, connection.workspaceId);
        const candidates = await monitorIssueRepository.listEnrichmentBackfillCandidates(
          connection.id,
          doneKeys,
          new Date(Date.now() - MONITOR_ENRICHMENT_BACKFILL_GRACE_MS),
          MONITOR_ENRICHMENT_BACKFILL_PER_POLL,
          tx,
        );
        const keep: Array<{ id: string; workItemId: string }> = [];
        for (const candidate of candidates) {
          const bug = await workItemRepository.findById(candidate.workItemId, tx);
          const filedBody = await workItemRevisionRepository.findCreatedDescription(
            candidate.workItemId,
            tx,
          );
          // The write's OWN predicate, so the sweep never asks for a body the
          // write would then refuse to apply.
          if (bug && isStillAsFiled(bug, filedBody)) keep.push(candidate);
        }
        return keep;
      });
      // Emitted AFTER the read committed. `sendEvent` is best-effort: a failed
      // enqueue writes no queue row, so the link is still undispatched and the
      // next poll finds it again.
      for (const candidate of eligible) {
        await sendEvent('monitor-issue/enrichment-backfill', {
          workspaceId: connection.workspaceId,
          projectId: connection.projectId,
          workItemId: candidate.workItemId,
          actorId: binderId,
          viaMonitorConnectionId: connection.id,
          idempotencyKey: `monitor-enrich-backfill:${candidate.id}`,
        });
        done.enrichmentRequested += 1;
      }
    }
  } catch (err) {
    console.warn(
      `[monitor-backfill] the backfill sweep for connection ${connection.id} stopped early; ` +
        'the next poll resumes it:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return done;
}

/** The connection a write is made ON — its id and the workspace its own row
 *  carries. Every connection write binds that workspace (MOTIR-10219): the
 *  `monitor_*` policies no longer admit a system-only write. */
type ConnectionRef = { id: string; workspaceId: string };

async function recordOutcome(
  connection: ConnectionRef,
  outcome: { status: 'ok' | 'failed'; error: string | null; filedCount: number | null },
): Promise<void> {
  await withWorkspaceServiceContext(connection.workspaceId, (tx) =>
    monitorConnectionRepository.recordPollOutcome(
      connection.id,
      { ...outcome, polledAt: new Date() },
      tx,
    ),
  );
}

/**
 * RESOLVE BACK's BACKSTOP (Story MOTIR-4931 · MOTIR-5703), at the end of a
 * successful poll: every claimable link on this connection whose bug is done is
 * resolved, capped. The event is the fast path; this is what makes the loop
 * self-healing — a failed resolve, a crashed one, and a done bug whose status
 * writer emitted no event are all caught here.
 *
 * ⚠️ A SWEEP FAILURE NEVER FAILS THE POLL. The ingestion outcome is already
 * recorded; an unexpected sweep error is caught and recorded on the connection's
 * SYNC failure, where the room shows it, and the poll's summary stands.
 */
async function sweepResolveBack(connection: ConnectionRef, resolveOnDone: boolean): Promise<void> {
  if (!resolveOnDone) return;
  try {
    await monitorSyncService.sweepConnection(connection.id);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await withWorkspaceServiceContext(connection.workspaceId, (tx) =>
      monitorConnectionRepository.recordSyncFailure(
        connection.id,
        {
          reason: `Resolving done bugs in the monitor stopped: ${why}`,
          workItemIdentifier: null,
          at: new Date(),
        },
        tx,
      ),
    );
  }
}

async function doneKeysOf(projectId: string, workspaceId: string): Promise<Set<string>> {
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
}

/** Record an unexpected assignee-sync error on the connection's SYNC failure —
 *  never on the poll's ingestion outcome, which stands. */
async function recordAssigneeError(connection: ConnectionRef, err: unknown): Promise<void> {
  const why = err instanceof Error ? err.message : String(err);
  await withWorkspaceServiceContext(connection.workspaceId, (tx) =>
    monitorConnectionRepository.recordSyncFailure(
      connection.id,
      {
        reason: `Taking assignees from the monitor stopped: ${why}`,
        workItemIdentifier: null,
        at: new Date(),
      },
      tx,
    ),
  );
}

/** One reconcile visit's assignee (MOTIR-5705). A failure here never turns a
 *  filed issue into a failed one. */
async function applyAssigneeQuietly(
  target: MonitorReconcileConnection,
  issue: NormalizedMonitorIssue,
  doneKeys: ReadonlySet<string>,
): Promise<void> {
  try {
    await monitorSyncService.applyAssignee(target, issue.externalId, issue.assignee, doneKeys);
  } catch (err) {
    await recordAssigneeError(target, err);
  }
}

/** The bounded assignee refresh at the end of a successful poll (MOTIR-5705).
 *  One link's refusal is absorbed inside the refresh; an unexpected error is
 *  recorded on the connection and the poll's outcome stands. */
async function refreshAssigneesQuietly(
  connection: {
    id: string;
    projectId: string;
    workspaceId: string;
    boundByUserId: string | null;
    installationId: string;
  },
  doneKeys: ReadonlySet<string>,
): Promise<void> {
  try {
    await monitorSyncService.refreshAssignees(connection, doneKeys);
  } catch (err) {
    await recordAssigneeError(connection, err);
  }
}

/** How far {@link resolveDuplicateTarget} follows a `duplicates` chain. */
const DUPLICATE_CHAIN_MAX_HOPS = 10;

/**
 * The LIVE card a done bug was closed as a duplicate of (Bug MOTIR-8512), or
 * null when it duplicates nothing live. Follows `duplicates` out of each done
 * card, so A → B → C reaches C when B is itself a done duplicate; a cycle or a
 * chain past {@link DUPLICATE_CHAIN_MAX_HOPS} ends with null. Of several
 * targets, a live one wins, then the first by id — the link table has no order
 * of its own, and a re-point must not flip between polls.
 */
async function resolveDuplicateTarget(
  doneBug: WorkItem,
  doneKeys: ReadonlySet<string>,
  tx: Prisma.TransactionClient,
): Promise<WorkItem | null> {
  const seen = new Set<string>([doneBug.id]);
  let frontier = doneBug;
  for (let hop = 0; hop < DUPLICATE_CHAIN_MAX_HOPS; hop += 1) {
    const edges = await workItemLinkRepository.findByFromItem(frontier.id, 'duplicates', tx);
    const targets: WorkItem[] = [];
    for (const edge of [...edges].sort((a, b) => a.toId.localeCompare(b.toId))) {
      if (seen.has(edge.toId)) continue;
      const target = await workItemRepository.findById(edge.toId, tx);
      if (target) targets.push(target);
    }
    const live = targets.find((target) => !doneKeys.has(target.status));
    if (live) return live;
    const next = targets[0];
    if (!next) return null;
    seen.add(next.id);
    frontier = next;
  }
  return null;
}

/** What the deciding transaction concluded. */
type ReconcileDecision =
  | { kind: 'settled'; result: MonitorReconcileResult }
  | {
      kind: 'file';
      /** The link as the decision saw it — the filing re-checks it under the lock. */
      expected: { workItemId: string | null; identifier: string | null };
      previous: PreviousBug | null;
      folderId: string | null;
    };

/** One attempt of {@link monitorIngestionService.reconcileIssue}: decide, then file. */
async function reconcileOnce(
  connection: MonitorReconcileConnection,
  issue: NormalizedMonitorIssue,
  read: MonitorContextRead | null | undefined,
  fixRelease: MonitorFixReleaseRead | null | undefined,
): Promise<MonitorReconcileResult> {
  const binderId = connection.boundByUserId;
  if (!binderId) throw new MonitorBinderUnavailableError(connection.id, BINDER_MISSING);

  const { projectId, workspaceId } = connection;
  const ctx = { userId: binderId, workspaceId };
  // Reference data, read before the lock: the project's own workflow decides
  // what "done" means, so a team's custom terminal status counts.
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  const doneKeys = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));

  const contextRead = read ?? MONITOR_CONTEXT_SKIPPED;
  const facts = factsOf(issue, contextRead);
  const updated = (bug: WorkItem): ReconcileDecision => ({
    kind: 'settled',
    result: { outcome: 'updated', workItemId: bug.id, identifier: bug.identifier },
  });

  // ── DECIDE ──────────────────────────────────────────────────────────────────
  // Short, and it FILES nothing: every write here is to a row that already
  // points at a bug. A decision to file is carried out by the create below.
  const decision = await withWorkspaceContext(
    { ...ctx, projectId },
    async (tx): Promise<ReconcileDecision> => {
      const lockedId = await monitorIssueRepository.lockByExternalId(
        connection.id,
        issue.externalId,
        tx,
      );
      const row: MonitorIssue | null = lockedId
        ? await monitorIssueRepository.findById(lockedId, tx)
        : null;

      // The bug the row points at, if any. A DELETED bug cannot be found here:
      // the FK is ON DELETE SET NULL, so deleting it cleared `workItemId` in the
      // same statement — and it keeps `filedWorkItemIdentifier`, which is how
      // "deleted" is told from "never filed" below.
      const bug = row?.workItemId ? await workItemRepository.findById(row.workItemId, tx) : null;
      if (row && bug && !doneKeys.has(bug.status)) {
        await writeLinkFacts(row.id, facts, contextRead, tx);
        return updated(bug);
      }

      // ── A DUPLICATE IS NOT A COMPLETION (Bug MOTIR-8512) ──────────────────────
      // `cancelled` is in the done category, so a bug a person closed as a
      // duplicate reads exactly like a fixed one — and every recurrence used to
      // file again, re-arming each duplicate the person had consolidated. When
      // the done bug `duplicates` a live card, the recurrence is THAT card's:
      // the link moves to it (`repoint` clears the per-link sync record, so the
      // resolve-back starts over for the card that now carries the issue) and
      // nothing is filed. A chain that ends in a done card re-files below, as
      // any completed bug does.
      if (row && bug) {
        const target = await resolveDuplicateTarget(bug, doneKeys, tx);
        if (target) {
          await monitorIssueRepository.repoint(row.id, target.id, target.identifier, tx);
          await writeLinkFacts(row.id, facts, contextRead, tx);
          return updated(target);
        }
      }

      // ── THE LOOP GUARD (Story MOTIR-4931 · Subtask MOTIR-5704) ──────────────
      // A done bug whose issue MOTIR ITSELF resolved, and which nobody has seen
      // since, is already reconciled — not a recurrence. Two orderings reach
      // this branch with no recurrence at all: a STALE PAGE (fetched while the
      // issue was unresolved, reconciled after the bug completed and the resolve
      // landed) and an IN-FLIGHT resolve (claimed `pending`, provider call not
      // yet returned). Both carry a resolve attempt and a `lastSeenAt` at or
      // before Motir's write, so both take `updated` — facts only, no work item
      // written. The guard reads MOTIR-side state only: on a shared credential
      // "we resolved it" and "they resolved it" are one identity to the
      // provider, so the provider's actor cannot tell them apart.
      //
      // ⚠️ THE ONE WINDOW IT ACCEPTS: the provider's `lastSeen` and Motir's clock
      // are different clocks. A regression whose ONLY event lands within the
      // clock skew of Motir's resolve reads as settled until its next event, and
      // that event then re-files normally.
      //
      // `updated` rather than a new outcome member, deliberately: it already
      // means "facts only, no card", and a new member would thread through the
      // poll summary and the room's poll line for no difference a person sees.
      if (row && bug && row.resolveAttemptedAt !== null) {
        const motirWrite = Math.max(
          row.resolveAttemptedAt.getTime(),
          row.resolvedByMotirAt?.getTime() ?? 0,
        );
        if (issue.lastSeenAt.getTime() <= motirWrite) {
          await writeLinkFacts(row.id, facts, contextRead, tx);
          return updated(bug);
        }
      }

      // ── THE FIX-RELEASE GUARD (Bug MOTIR-8330) ──────────────────────────────
      // A done bug whose fix the event's release does not carry has not been
      // TESTED by that event: it is the old build still serving between the merge
      // that completed the bug and the deploy that ships it. Facts only, no card —
      // and the next event from a release that DOES carry the merge re-files
      // normally, because this guard reads each visit's own release.
      //
      // It keys on the bug the row points at NOW, under the lock: an answer read
      // for a bug the link no longer names (re-pointed, deleted) is not about this
      // decision. A bug completed with no merge never gets an answer at all
      // (`readFixReleaseQuietly` returns null), so it re-files as before.
      if (row && bug && fixRelease?.workItemId === bug.id && fixRelease.containment === 'missing') {
        await writeLinkFacts(row.id, facts, contextRead, tx);
        return updated(bug);
      }

      const previous: PreviousBug | null = bug
        ? { identifier: bug.identifier, workItemId: bug.id, reason: 'completed' }
        : row?.filedWorkItemIdentifier
          ? { identifier: row.filedWorkItemIdentifier, workItemId: null, reason: 'deleted' }
          : null;

      // Placement comes from the resolver and NOWHERE else (MOTIR-4927): its
      // folder, or the project root when that is what the project chose.
      const { folderId } = await bugDestinationService.resolve(projectId, tx);
      return {
        kind: 'file',
        expected: {
          workItemId: row?.workItemId ?? null,
          identifier: row?.filedWorkItemIdentifier ?? null,
        },
        previous,
        folderId,
      };
    },
  );
  if (decision.kind === 'settled') return decision.result;

  // ── FILE — the bug and its link in ONE transaction ──────────────────────────
  const { expected, previous, folderId } = decision;
  let created;
  try {
    created = await workItemsService.createWorkItem(
      {
        projectId,
        kind: 'bug',
        title: monitorBugTitle(issue.title),
        folderId,
        descriptionMd: monitorBugBody(issue, connection.externalProjectSlug, previous),
      },
      // The provenance stamp the bug ENRICHMENT trigger reads (MOTIR-5849). The
      // link now commits with the bug, so the event never precedes it; the stamp
      // still says which binding filed it.
      { ...ctx, viaMonitorConnectionId: connection.id },
      {
        inTransaction: async (bug, tx) => {
          await monitorIssueRepository.insertIfAbsent(
            {
              connectionId: connection.id,
              projectId,
              workspaceId,
              externalIssueId: issue.externalId,
              ...facts,
            },
            tx,
          );
          const lockedId = await monitorIssueRepository.lockByExternalId(
            connection.id,
            issue.externalId,
            tx,
          );
          const row = lockedId ? await monitorIssueRepository.findById(lockedId, tx) : null;
          if (
            !row ||
            row.workItemId !== expected.workItemId ||
            row.filedWorkItemIdentifier !== expected.identifier
          ) {
            throw new MonitorFilingRaceError(issue.externalId);
          }
          await writeLinkFacts(row.id, facts, contextRead, tx);
          await monitorIssueRepository.markFiled(row.id, bug.id, bug.identifier, tx);
        },
      },
    );
  } catch (err) {
    if (isBinderRefusal(err)) {
      throw new MonitorBinderUnavailableError(connection.id, BINDER_CANNOT_FILE);
    }
    throw err;
  }

  const relatesTo = previous?.reason === 'completed' ? previous.workItemId : null;
  if (relatesTo) {
    // The body names the completed key, and a body that REFERENCES another
    // item already gets a `relates_to` mention edge from the create path
    // (Subtask 5.8.3). The explicit link is what makes the edge a property of
    // this method rather than of the body's wording — so a duplicate is the
    // edge already being there: success, exactly as `link_work_items` treats it.
    try {
      await workItemsService.linkWorkItems(
        relationshipToLink('relates_to', created.id, relatesTo),
        ctx,
      );
    } catch (err) {
      if (!(err instanceof DuplicateLinkError)) throw err;
    }
  }

  return {
    outcome: previous ? 'refiled' : 'filed',
    workItemId: created.id,
    identifier: created.identifier,
  };
}

export const monitorIngestionService = {
  /**
   * Bring Motir into agreement with ONE provider issue for ONE binding.
   *
   * The `monitor_issue` row is LOCKED first (`SELECT … FOR UPDATE`, when it
   * exists), and exactly one outcome applies to its state:
   *
   * | row state                                       | outcome                        |
   * |-------------------------------------------------|--------------------------------|
   * | no bug ever filed (or no row yet)               | `filed`                        |
   * | bug live (not done-category; ARCHIVED counts)   | `updated` — facts only         |
   * | bug done, and it `duplicates` a live card        | `updated` — the link MOVES to  |
   * |   (following the chain, Bug MOTIR-8512)          |   that card                    |
   * | bug done, and MOTIR resolved the issue with no   | `updated` — facts only (the     |
   * |   sighting since (MOTIR-5704's loop guard)       |   loop guard)                   |
   * | bug done, and the event's release lacks the     | `updated` — facts only (the     |
   * |   merge that completed it (MOTIR-8330)           |   fix-release guard)            |
   * | bug in a done-category status                   | `refiled`, `relates_to` the old |
   * | bug deleted (null pointer, key remembered)      | `refiled`, body names the key  |
   *
   * An ARCHIVED bug is live: a person chose to archive it, and filing again
   * would override that choice. A DONE one is never re-opened — the poll only
   * hands this method an issue seen after its watermark, so a done bug here is a
   * recurrence after completion, and we plan forward. A done bug that a person
   * closed as a DUPLICATE was not completed, though: its work lives on in the card
   * it duplicates, so the recurrence belongs to THAT card, and filing again would
   * undo the person's consolidation one recurrence at a time.
   *
   * ⚠️ WHOSE NAME: the binder's, through `workItemsService.createWorkItem` with
   * the binder's context — every create guard (the edit gate, the reporter
   * membership check, key allocation) runs unchanged. NOT
   * `aiWorkItemsService.fileBug`: it acts as the system principal, which exists
   * only in Motir's own META workspace (`lib/ai/serviceAuth.ts`
   * `resolveSystemPrincipal`) and so cannot file into a customer project. A
   * missing binder, or one the create refuses, is
   * {@link MonitorBinderUnavailableError} and NOTHING is written.
   *
   * ⚠️ THE BUG AND ITS LINK COMMIT TOGETHER (Bug MOTIR-8512). Deciding happens in
   * one short transaction that files nothing; a decision to file then hands the
   * create an in-transaction step that claims the row (insert-if-absent, then
   * lock), checks the link is still what the decision saw, writes the facts and
   * points the row at the new bug — inside the CREATE's own transaction. So a
   * failed link rolls the bug back with it, and no committed bug ever lacks its
   * link: there is no orphan for the next poll to duplicate. Before this, the
   * create committed on its own while the link waited on an outer transaction
   * that stayed open across it; when that outer transaction expired (P2028) the
   * bug stood unlinked and every later poll filed another.
   *
   * ⚠️ THE RACE: two reconcilers of one issue can both decide to file. The first
   * to take the row lock links its bug and commits; the second finds the link
   * moved, throws {@link MonitorFilingRaceError} inside its create (rolling its
   * bug back), and decides again — now reading the first one's live bug, so it
   * takes `updated`. Two concurrent reconciles of one new issue produce exactly
   * `{filed, updated}`.
   *
   * The `relates_to` edge on a re-file of a COMPLETED bug is written after the
   * filing commits: a failure there leaves a correctly linked row missing only
   * its cross-reference, rather than an unmarked bug the next run would duplicate.
   */
  async reconcileIssue(
    connection: MonitorReconcileConnection,
    issue: NormalizedMonitorIssue,
    /**
     * The issue's latest-event context read, MADE BY THE CALLER before this
     * method takes its row lock (MOTIR-5729) — a provider call held inside the
     * lock would hold a row lock across a network round trip. Its facts and its
     * evidence (MOTIR-5979) are written with the other facts on every outcome;
     * absent, `null` or `skipped` leaves the stored values alone. It changes no
     * DECISION below.
     */
    read?: MonitorContextRead | null,
    /**
     * Whether that read's release carries the merge that completed the linked bug
     * (Bug MOTIR-8330), also read by the caller before the lock. `missing` on the
     * bug the row still points at holds a re-file; absent or `null` changes
     * nothing.
     */
    fixRelease?: MonitorFixReleaseRead | null,
  ): Promise<MonitorReconcileResult> {
    try {
      return await reconcileOnce(connection, issue, read, fixRelease);
    } catch (err) {
      if (!(err instanceof MonitorFilingRaceError)) throw err;
      // Another reconciler filed first; decide again against its link. Once:
      // a second loss in a row is not a race this method can settle.
      return reconcileOnce(connection, issue, read, fixRelease);
    }
  },

  /**
   * The FACTS-ONLY refresh of an issue below the connection's minimum level
   * that a person has LINKED to a work item (Story MOTIR-4932 · Subtask
   * MOTIR-5729). Returns whether it wrote.
   *
   * The minimum level is a FILING filter, and it stays one: nothing here files,
   * re-files or re-points. But a hand-made link below the level would otherwise
   * freeze its count and last-seen at the moment it was linked — the one number
   * the Errors section exists to keep honest. So under the SAME claim-or-lock the
   * reconciler takes (lock the row, re-read it), the facts are written when, and
   * only when, the row still points at a LIVE bug: not in a done-category status,
   * not deleted (an archived one is live, as it is for the reconciler). A done
   * bug is skipped exactly as today — re-filing an issue the filter excludes
   * would defeat the filter.
   *
   * SYSTEM context with the workspace bound: `monitor_issue` has a system arm and
   * `work_item` has none, and an unbound read of the bug would come back empty
   * and read as "deleted" (the `monitorSyncService` idiom).
   */
  async refreshLinkedFacts(
    connection: Pick<MonitorReconcileConnection, 'id' | 'projectId' | 'workspaceId'>,
    issue: NormalizedMonitorIssue,
    read?: MonitorContextRead | null,
  ): Promise<boolean> {
    const doneKeys = await doneKeysOf(connection.projectId, connection.workspaceId);
    return withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, connection.workspaceId);
      const lockedId = await monitorIssueRepository.lockByExternalId(
        connection.id,
        issue.externalId,
        tx,
      );
      if (lockedId === null) return false;
      const row = await monitorIssueRepository.findById(lockedId, tx);
      if (!row?.workItemId) return false;
      const bug = await workItemRepository.findById(row.workItemId, tx);
      if (!bug || doneKeys.has(bug.status)) return false;
      const contextRead = read ?? MONITOR_CONTEXT_SKIPPED;
      await writeLinkFacts(row.id, factsOf(issue, contextRead), contextRead, tx);
      return true;
    });
  },

  /**
   * Run ONE reconcile pass for ONE binding, and record on that binding what
   * happened (Story MOTIR-4929 · Subtask MOTIR-5580). The scheduled job calls
   * it (MOTIR-5581) and nothing else does.
   *
   * 1. READ the binding in system context. The watermark in effect is
   *    `lastSeenWatermark ?? createdAt` — the NEW-issue rule: nothing from before
   *    the binding is back-filled. The minimum level read HERE is what the final
   *    advance compares against.
   * 2. LIST every page since the watermark through
   *    `monitorCredentialService.withFreshCredential` — it refreshes an expired
   *    token, retries once on a 401, and writes `degraded` with the provider's
   *    reason on a second refusal. Stops at a `null` cursor or at
   *    {@link MONITOR_POLL_MAX_PAGES}, which is a FAILED outcome with the
   *    watermark left where it was — loud, never a silent truncation.
   * 3. FILTER: an issue below the minimum level is counted as skipped —
   *    UNLESS a person linked it to a live work item, when its facts are
   *    refreshed and nothing is filed ({@link refreshLinkedFacts}, counted as
   *    `refreshed`; MOTIR-5729). Before each visit the issue's latest-event
   *    context is read OUTSIDE any lock, at most
   *    {@link MONITOR_CONTEXT_READS_PER_POLL} times, and a failed read changes
   *    nothing but those two columns' freshness.
   * 4. RECONCILE each remaining issue through {@link reconcileIssue}. One issue
   *    failing (a binder refusal included) does not stop the others. When the
   *    issue's linked bug is done and was completed by a merge, the host is asked
   *    first — also outside any lock — whether the event's release carries that
   *    merge (MOTIR-8330); a release that predates it holds the re-file.
   * 5. RECORD: all reconciled ⇒ advance the watermark (compare-and-set on the
   *    level read at 1, so a lowering that landed mid-poll is NOT undone), record
   *    `ok`, and write the grant's health `connected` — a working poll is
   *    evidence the credential works, so "checked N minutes ago" stays true. Any
   *    failure ⇒ record `failed` naming it and do NOT advance, so the failed
   *    issue is read again next time. A PROVIDER refusal records `failed` with
   *    the provider's own reason and RETURNS rather than throws, so a revoked
   *    credential does not burn the job's retries. Anything else is thrown for
   *    the job's retry and terminal path.
   *
   * ⚠️ IT NEVER PROBES. `monitorCredentialService.probeHealth` is the settings
   * room's door, and it asserts a person's permission; a job reaching for it is
   * the boundary MOTIR-5261 drew. The poll's own success is its health signal.
   */
  async pollConnection(connectionId: string): Promise<MonitorPollSummary> {
    const pollStartedAt = new Date();
    const connection = await withSystemContext((tx) =>
      monitorConnectionRepository.findById(connectionId, tx),
    );
    if (!connection) return NOTHING_POLLED;

    const minimumLevelAtStart = connection.minimumLevel;
    const lastSeenAfter = connection.lastSeenWatermark ?? connection.createdAt;

    // ── 2. LIST ────────────────────────────────────────────────────────────────
    const listed: NormalizedMonitorIssue[] = [];
    // The credential the LAST successful page was read with — the one the
    // context reads reuse (MOTIR-5729), so they cost no credential round trip.
    let listingCredential: MonitorAccessToken | null = null;
    // The GRANT's workspace, as its own row reports it through the credential —
    // what the health write at the end binds (MOTIR-10219).
    let grantWorkspaceId: string | null = null;
    let pages = 0;
    let cursor: string | null = null;
    try {
      do {
        if (pages === MONITOR_POLL_MAX_PAGES) {
          const reason =
            `More than ${MONITOR_POLL_MAX_PAGES * MONITOR_ISSUES_PAGE_LIMIT} issues ` +
            `(${MONITOR_POLL_MAX_PAGES} pages) since the last check. Nothing was skipped silently: ` +
            'raise the minimum level, or the next check reads them again.';
          await recordOutcome(connection, { status: 'failed', error: reason, filedCount: null });
          return { ...NOTHING_POLLED, status: 'failed', pages };
        }
        const pageCursor: string | null = cursor;
        const page: NormalizedMonitorIssuePage = await monitorCredentialService.withFreshCredential(
          connection.installationId,
          async (credential) => {
            const read = await getMonitorProvider(credential.provider).listIssuesSince({
              accessToken: credential.token,
              orgSlug: credential.orgSlug ?? '',
              externalProjectId: connection.externalProjectId,
              lastSeenAfter,
              cursor: pageCursor,
            });
            listingCredential = credential;
            grantWorkspaceId = credential.workspaceId;
            return read;
          },
        );
        pages += 1;
        listed.push(...page.issues);
        cursor = page.nextCursor;
      } while (cursor !== null);
    } catch (err) {
      if (!(err instanceof MonitorProviderCallError)) throw err;
      // `withFreshCredential` has already written `degraded` where the refusal
      // was the credential's. Either way the reason is the PROVIDER's own words.
      await recordOutcome(connection, {
        status: 'failed',
        error: err.providerReason,
        filedCount: null,
      });
      return { ...NOTHING_POLLED, status: 'failed', pages };
    }

    // ── 3–4. FILTER + RECONCILE ──────────────────────────────────────────────
    const summary: MonitorPollSummary = { ...NOTHING_POLLED, pages };
    const failures: string[] = [];
    // The project's done category, read once — only when the assignee direction
    // is on, so a switched-off connection makes no read on its behalf.
    const assigneeDoneKeys = connection.syncAssignee
      ? await doneKeysOf(connection.projectId, connection.workspaceId)
      : null;
    // The same done category for the fix-release read (MOTIR-8330), read at most
    // once and only when an issue's latest event named a release commit.
    let reconcileDoneKeysRead: Promise<ReadonlySet<string>> | null = assigneeDoneKeys
      ? Promise.resolve(assigneeDoneKeys)
      : null;
    const reconcileDoneKeys = (): Promise<ReadonlySet<string>> =>
      (reconcileDoneKeysRead ??= doneKeysOf(connection.projectId, connection.workspaceId));
    const target: MonitorReconcileConnection = {
      id: connection.id,
      projectId: connection.projectId,
      workspaceId: connection.workspaceId,
      boundByUserId: connection.boundByUserId,
      externalProjectSlug: connection.externalProjectSlug,
    };
    // A below-minimum issue is worth a visit only when a person linked it to a
    // work item (MOTIR-5729) — ONE read tells those apart from the ones merely
    // skipped, so an unlinked noisy issue never costs a context read.
    const belowMinimum = listed.filter(
      (issue) => !meetsMinimumLevel(issue.level, minimumLevelAtStart),
    );
    const linkedBelowMinimum = new Set(
      belowMinimum.length === 0
        ? []
        : (
            await withSystemContext((tx) =>
              monitorIssueRepository.listLinkedByExternalIds(
                connection.id,
                belowMinimum.map((issue) => issue.externalId),
                tx,
              ),
            )
          ).map((link) => link.externalIssueId),
    );
    // Context reads happen HERE, before `reconcileIssue` / `refreshLinkedFacts`
    // take their row lock, and never more than the cap per poll.
    let contextReads = 0;
    const credentialForContext: MonitorAccessToken | null = listingCredential;
    const contextFor = async (issue: NormalizedMonitorIssue): Promise<MonitorContextRead> => {
      if (!credentialForContext || contextReads >= MONITOR_CONTEXT_READS_PER_POLL) {
        return MONITOR_CONTEXT_SKIPPED;
      }
      contextReads += 1;
      return readContextQuietly(credentialForContext, issue.externalId);
    };
    for (const issue of listed) {
      if (!meetsMinimumLevel(issue.level, minimumLevelAtStart)) {
        if (!linkedBelowMinimum.has(issue.externalId)) {
          summary.skipped += 1;
          continue;
        }
        try {
          const context = await contextFor(issue);
          const wrote = await monitorIngestionService.refreshLinkedFacts(target, issue, context);
          if (wrote) summary.refreshed += 1;
          else summary.skipped += 1;
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          failures.push(`Issue ${issue.externalId} (“${issue.title}”) was not refreshed: ${why}`);
        }
        continue;
      }
      try {
        const context = await contextFor(issue);
        const fixRelease = await readFixReleaseQuietly(target, issue, context, reconcileDoneKeys);
        const result = await monitorIngestionService.reconcileIssue(
          target,
          issue,
          context,
          fixRelease,
        );
        summary[result.outcome] += 1;
        // ASSIGNEE FROM THE MONITOR (MOTIR-4931 · MOTIR-5705), on every reconcile
        // visit, with the assignee the page already carried. A hook BESIDE
        // `reconcileIssue`, never inside it (the loop guard edits that method).
        if (assigneeDoneKeys) {
          await applyAssigneeQuietly(target, issue, assigneeDoneKeys);
        }
      } catch (err) {
        const why =
          err instanceof MonitorBinderUnavailableError
            ? err.reason
            : err instanceof Error
              ? err.message
              : String(err);
        failures.push(`Issue ${issue.externalId} (“${issue.title}”) was not filed: ${why}`);
      }
    }

    // ── 4b. THE STANDING BACKFILL SWEEP (MOTIR-5983) ─────────────────────────
    // After the page walk's own writes, with its credential and what is left of
    // its read budget. It never changes the outcome recorded below.
    const backfill = await sweepBackfill(
      connection,
      credentialForContext,
      MONITOR_CONTEXT_READS_PER_POLL - contextReads,
      pollStartedAt,
    );
    summary.evidenceBackfilled = backfill.evidenceBackfilled;
    summary.enrichmentRequested = backfill.enrichmentRequested;

    // ── 5. RECORD ─────────────────────────────────────────────────────────────
    if (failures.length > 0) {
      const error =
        failures.length === 1
          ? failures[0]!
          : `${failures[0]!} (and ${failures.length - 1} more issue${failures.length === 2 ? '' : 's'})`;
      await recordOutcome(connection, { status: 'failed', error, filedCount: null });
      return { ...summary, status: 'failed' };
    }

    if (listed.length > 0) {
      const newest = new Date(Math.max(...listed.map((issue) => issue.lastSeenAt.getTime())));
      await withWorkspaceServiceContext(connection.workspaceId, (tx) =>
        monitorConnectionRepository.advanceWatermark(
          connection.id,
          newest,
          minimumLevelAtStart,
          tx,
        ),
      );
    }
    await recordOutcome(connection, {
      status: 'ok',
      error: null,
      filedCount: summary.filed + summary.refiled,
    });
    // The GRANT's own workspace, from the credential its row produced; a binding
    // and its grant share one (`bindProject` binds the workspace's own grant).
    await withWorkspaceServiceContext(grantWorkspaceId ?? connection.workspaceId, (tx) =>
      monitorInstallationRepository.updateHealth(
        connection.installationId,
        { health: 'connected', healthReason: null, healthCheckedAt: new Date() },
        tx,
      ),
    );
    await sweepResolveBack(connection, connection.resolveOnDone);
    if (assigneeDoneKeys) {
      await refreshAssigneesQuietly(connection, assigneeDoneKeys);
    }
    return summary;
  },

  /**
   * Every binding the scheduled tick should poll — its id and whose it is —
   * across every workspace (MOTIR-5581). SYSTEM context: the tick does not know
   * whose bindings exist until it has read them.
   */
  async listPollableConnections(): Promise<Array<{ id: string; workspaceId: string }>> {
    const rows = await withSystemContext((tx) => monitorConnectionRepository.listForPolling(tx));
    return rows.map((row) => ({ id: row.id, workspaceId: row.workspaceId }));
  },

  /**
   * Write a TERMINAL poll failure onto the binding (MOTIR-5581) — the job's final
   * attempt calls this before rethrowing into the dead-letter queue, so the
   * failure is visible in the Monitoring room and not only in a table nobody
   * reads (MOTIR-4918). A binding deleted in the meantime has nowhere to show
   * it, so that write is skipped rather than thrown over the real error.
   */
  async recordTerminalFailure(connectionId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await withSystemContext(async (tx) => {
      const row = await monitorConnectionRepository.findById(connectionId, tx);
      if (!row) return;
      // The row's own workspace, found by the system read above (MOTIR-10219).
      await bindWorkspaceContext(tx, row.workspaceId);
      await monitorConnectionRepository.recordPollOutcome(
        connectionId,
        {
          status: 'failed',
          error: `The check stopped after repeated failures: ${message}`,
          filedCount: null,
          polledAt: new Date(),
        },
        tx,
      );
    });
  },
};
