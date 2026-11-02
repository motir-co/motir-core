import 'server-only';

import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import { describedForWrite, InvalidAuthoredBugError, parseAuthoredBug } from '@/lib/ai/authoredBug';
import { MotirAiError } from '@/lib/ai/errors';
import { resolveProjectCodeContext } from '@/lib/ai/codeContext';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { resolveTenantLanguages } from '@/lib/ai/tenantLanguages';
import type { BugAuthoringContext } from '@/lib/ai/types';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { getMonitorProvider } from '@/lib/monitors';
import { isStillAsFiled } from '@/lib/monitors/asFiled';
import { MonitorLinkNotYetVisibleError } from '@/lib/monitors/errors';
import type { NormalizedMonitorIssueContext } from '@/lib/monitors/types';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { StaleWorkItemError, WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { readProject } from '@/lib/workspaces/tenantRead';

// The bug ENRICHMENT trigger's dispatch (Story MOTIR-4930 · Subtask MOTIR-5849) —
// when the monitor reconciler files a `bug`, ask motir-ai to PLAN it: assemble
// the issue's facts, re-read its latest event for the stack frames, resolve the
// project's repository set, and submit exactly ONE `author_bug` job.
//
// TWO HALVES, one per work item. `dispatchEnrichment` (MOTIR-5849) submits and
// records the job id on the link row, and writes nothing onto the card.
// `applyAuthoredBug` (MOTIR-5851) reads the finished job, RE-VALIDATES its answer
// and writes it onto the bug as the binder — only while the card is still exactly
// as it was filed.
//
// ⚠️ IT RUNS IN ITS OWN JOB, AFTER THE FILING COMMITTED — the whole safety
// property. `lib/jobs/definitions/monitorBugEnrich.ts` rides `work-item/created`,
// which is emitted post-commit, so a model call can never sit inside
// `reconcileIssue`'s transaction, and a dispatch that fails is retried without the
// filing ever knowing. There is no arrangement of this code in which a failed
// enrichment loses a bug, because the bug exists before enrichment can start.
//
// The template is `aiBugTelemetryService.dispatchOutwardAnalysis`: every
// not-a-candidate answer is a VALUE, and only a genuine transport failure (or the
// ordering window below) throws, for the retry budget to absorb.

/** The `work-item/created` fields the trigger forwards. */
export interface MonitorBugEnrichmentTrigger {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  actorId: string;
  /** Monitor provenance — present only when the reconciler FILED the item. */
  viaMonitorConnectionId?: string;
}

/** Why nothing was dispatched. Each is a normal answer, never a failure. */
export type MonitorBugEnrichmentSkip =
  /** No motir-ai backend on this deployment (a self-hosted open-core build). */
  | 'ai-not-configured'
  /** The created item is not a `bug` (or is already gone). */
  | 'not-a-bug'
  /** No monitor link points at it — the bug was filed by hand. */
  | 'no-monitor-link'
  /** The link already carries a dispatched job — a redelivered event. */
  | 'already-dispatched'
  /** The binding has no binder to act as, so there is no identity to submit AS. */
  | 'no-binder';

export type MonitorBugEnrichmentOutcome =
  | { dispatched: true; jobId: string; framesRead: boolean }
  | { dispatched: false; reason: MonitorBugEnrichmentSkip };

/** Whether the closed motir-ai backend is wired for this deployment — the probe
 *  `aiBugTelemetryService` uses. Unconfigured is a VALUE: a self-hosted build must
 *  not dead-letter on every monitor bug. */
function motirAiConfigured(): boolean {
  return Boolean(process.env['MOTIR_AI_URL'] && process.env['MOTIR_AI_SERVICE_TOKEN']);
}

const iso = (d: Date) => d.toISOString();

/** Why an answer was NOT written. Each leaves the bug filed and unenriched, with
 *  no partial write — a value, never an error. */
export type MonitorAuthoringSkip =
  /** motir-ai reports the job failed or was cancelled. */
  | 'job-failed'
  /** The answer failed re-validation at this boundary — one field is enough. */
  | 'invalid-answer'
  /** motir-ai could not be reached when the result was read. */
  | 'ai-unreachable'
  /** The bounded wait elapsed with the job still running (the job function's
   *  `MONITOR_AUTHORING_POLLS`, `lib/jobs/definitions/monitorBugEnrich.ts`). */
  | 'timed-out'
  /** The card is no longer the thin card that was filed — written already, or
   *  edited by a person. Either way it is left exactly as it stands. */
  | 'card-changed'
  /** The bug is in a done-category status (`done`, `cancelled`, or a team's own). */
  | 'terminal-status'
  /** The bug, its link or its binder is gone. */
  | 'bug-gone';

export type MonitorAuthoringOutcome =
  | { status: 'applied' }
  | { status: 'pending' }
  | { status: 'skipped'; reason: MonitorAuthoringSkip };

export const monitorBugEnrichmentService = {
  /**
   * Decide whether a freshly-created work item is a monitor bug awaiting
   * enrichment and, if so, dispatch ONE `author_bug` job for it.
   *
   * Eligibility, in order, each a cheap read before an expensive one: motir-ai
   * configured → the item is a `bug` → the reconciler filed it (provenance) and a
   * link row points at it → that row has no `authoringJobId` → the binding has a
   * binder. Only then is anything assembled.
   *
   * ⚠️ IDEMPOTENT ON THE LINK ROW. `authoringJobId` is read before the submit and
   * written after it, so a sequentially redelivered event dispatches nothing. Two
   * CONCURRENT deliveries of one event are not a shape the job engine produces
   * (it claims one run at a time), so the check-submit-mark sequence is not
   * locked; the conditional write still refuses a second key.
   */
  async dispatchEnrichment(
    trigger: MonitorBugEnrichmentTrigger,
  ): Promise<MonitorBugEnrichmentOutcome> {
    if (!motirAiConfigured()) return { dispatched: false, reason: 'ai-not-configured' };

    // The event omits `kind`, so the item is read — AS its creator, who for a
    // monitor bug is the binder. Reading it here is also the proof that this runs
    // after the create committed: an uncommitted row is not visible to this read.
    let item: WorkItemDto;
    try {
      item = await workItemsService.getWorkItem(trigger.workItemId, {
        userId: trigger.actorId,
        workspaceId: trigger.workspaceId,
      });
    } catch (err) {
      if (err instanceof WorkItemNotFoundError) return { dispatched: false, reason: 'not-a-bug' };
      throw err;
    }
    if (item.kind !== 'bug') return { dispatched: false, reason: 'not-a-bug' };

    // A bug filed by hand carries no provenance and cannot have a link at the
    // moment of its creation (a hand-made link is made afterwards, to an EXISTING
    // card) — so there is nothing to look up.
    const connectionId = trigger.viaMonitorConnectionId;
    if (!connectionId) return { dispatched: false, reason: 'no-monitor-link' };

    const { link, connection } = await withSystemContext(async (tx) => ({
      link: await monitorIssueRepository.findByWorkItemId(connectionId, item.id, tx),
      connection: await monitorConnectionRepository.findById(connectionId, tx),
    }));
    // The ordering window. Since MOTIR-8512 the reconciler writes the link in
    // the create's own transaction and the created event follows that commit,
    // so this should not happen; it stays a retryable throw rather than a skip.
    if (!link) {
      if (!connection) return { dispatched: false, reason: 'no-monitor-link' };
      throw new MonitorLinkNotYetVisibleError(connectionId, item.id);
    }
    if (link.authoringJobId) return { dispatched: false, reason: 'already-dispatched' };
    if (!connection?.boundByUserId) return { dispatched: false, reason: 'no-binder' };

    const binder = { userId: connection.boundByUserId, workspaceId: trigger.workspaceId };

    // The latest event, for the frames. A failed or refused read DEGRADES the
    // envelope — frames are the best input, not a required one — exactly as the
    // reconciler's own context read degrades. The stored environment and release
    // then stand in.
    const context = await readLatestEventQuietly(connection.installationId, link.externalIssueId);

    const project = await readProject(trigger.projectId, binder);
    if (!project?.identifier) return { dispatched: false, reason: 'not-a-bug' };

    const code = await resolveProjectCodeContext({ ...binder, projectId: trigger.projectId });

    const bugAuthoring: BugAuthoringContext = {
      issue: {
        title: link.title,
        culprit: link.culprit,
        level: link.level,
        eventCount: link.eventCount,
        firstSeenAt: iso(link.firstSeenAt),
        lastSeenAt: iso(link.lastSeenAt),
        permalink: link.permalink,
      },
      environment: context ? context.environment : link.environment,
      release: context ? context.release : link.release,
      frames: context?.frames ?? [],
      monitoredProjectSlug: connection.externalProjectSlug,
    };

    const { organizationId, isMeta, internalBilling } = await resolveTenantOrg(binder);
    // The two languages (MOTIR-8742) with NO person: a monitor filed this bug, and
    // the binder is only the identity the job token is scoped to — not someone the
    // write-up speaks to. So the explanation is written in the content language.
    const languages = await resolveTenantLanguages({
      workspaceId: trigger.workspaceId,
      userId: null,
    });
    const { jobId } = await submitJob(
      'author_bug',
      {
        organizationId,
        isMeta,
        internalBilling,
        workspaceId: trigger.workspaceId,
        projectId: trigger.projectId,
        projectKey: project.identifier,
        ...languages,
      },
      // `code` absent — not an empty set — for a project with no established
      // repository: motir-ai reads that as `no_repos` and degrades.
      { bugAuthoring, ...(code ? { code } : {}) },
      // AS THE BINDER: the identity the bug was filed as, so the job token is
      // scoped to a user who can actually see this project.
      { userId: binder.userId },
    );

    // The link's own workspace (MOTIR-10219): `monitor_issue` admits no
    // system-only write.
    await withWorkspaceServiceContext(link.workspaceId, (tx) =>
      monitorIssueRepository.markAuthoringDispatched(link.id, jobId, tx),
    );
    return { dispatched: true, jobId, framesRead: context !== null };
  },

  /**
   * The trigger the `work-item/created` event carried for a bug the reconciler
   * FILED, rebuilt from its link row — or `null` when no binding in this workspace
   * filed it. The acceptance lane's `_test` enrichment door uses it to run the SAME
   * dispatch-and-apply the job runs, in the one process that holds the lane's
   * motir-ai fake (`app/api/_test/monitors/enrich/route.ts`).
   */
  async triggerForFiledBug(
    workItemId: string,
    workspaceId: string,
  ): Promise<MonitorBugEnrichmentTrigger | null> {
    return withSystemContext(async (tx) => {
      const links = await monitorIssueRepository.listByWorkItem(workItemId, tx);
      const link = links.find((row) => row.workspaceId === workspaceId);
      if (!link) return null;
      const connection = await monitorConnectionRepository.findById(link.connectionId, tx);
      if (!connection?.boundByUserId) return null;
      return {
        workspaceId,
        projectId: link.projectId,
        workItemId,
        actorId: connection.boundByUserId,
        viaMonitorConnectionId: connection.id,
      };
    });
  },

  /**
   * Read a dispatched `author_bug` and, if it has finished with a valid answer,
   * WRITE it onto the bug (MOTIR-5851). `pending` while the job is still running;
   * the job function calls this after each durable sleep, up to its bound.
   *
   * ⚠️ ONE PREDICATE CARRIES BOTH THE IDEMPOTENCY AND THE NEVER-OVERWRITE RULE:
   * the write happens only while the bug's description is still EXACTLY the body
   * it was created with and its explanation is still empty. A second delivery
   * finds an enriched body and skips; a person who edited the card first finds
   * the edit untouched. The comparison is against the `created` revision — an
   * immutable record of what the reconciler wrote — so it cannot drift when a
   * recurrence moves the issue's facts on. The write then carries
   * `expectedUpdatedAt`, so an edit landing between this read and the write is
   * refused rather than overwritten.
   *
   * The status is read only for the done category: `done` / `cancelled` (or a
   * team's own terminal status) is never written. Every other status is decided
   * by the predicate alone — a card somebody started but has not edited still
   * gets its body. Nothing here transitions a status.
   */
  async applyAuthoredBug(
    trigger: MonitorBugEnrichmentTrigger,
    jobId: string,
  ): Promise<MonitorAuthoringOutcome> {
    const connectionId = trigger.viaMonitorConnectionId;
    if (!connectionId) return { status: 'skipped', reason: 'bug-gone' };
    const { link, connection } = await withSystemContext(async (tx) => ({
      link: await monitorIssueRepository.findByWorkItemId(connectionId, trigger.workItemId, tx),
      connection: await monitorConnectionRepository.findById(connectionId, tx),
    }));
    if (!link || !connection?.boundByUserId) return { status: 'skipped', reason: 'bug-gone' };
    const binder = { userId: connection.boundByUserId, workspaceId: trigger.workspaceId };

    let view;
    try {
      view = await getJob(jobId, trigger.projectId);
    } catch (err) {
      if (err instanceof MotirAiError) return { status: 'skipped', reason: 'ai-unreachable' };
      throw err;
    }
    if (view.status === 'queued' || view.status === 'running') return { status: 'pending' };
    if (view.status !== 'succeeded') return { status: 'skipped', reason: 'job-failed' };

    let answer;
    try {
      answer = parseAuthoredBug(view.result?.authoredBug);
    } catch (err) {
      if (err instanceof InvalidAuthoredBugError) {
        return { status: 'skipped', reason: 'invalid-answer' };
      }
      throw err;
    }

    let bug: WorkItemDto;
    try {
      bug = await workItemsService.getWorkItem(trigger.workItemId, binder);
    } catch (err) {
      if (err instanceof WorkItemNotFoundError) return { status: 'skipped', reason: 'bug-gone' };
      throw err;
    }

    const statuses = await workflowsService.listStatusesByProject(
      bug.projectId,
      binder.workspaceId,
    );
    const category = statuses.find((s) => s.key === bug.status)?.category;
    if (category === 'done') return { status: 'skipped', reason: 'terminal-status' };

    const filedBody = await withWorkspaceContext({ ...binder, projectId: bug.projectId }, (tx) =>
      workItemRevisionRepository.findCreatedDescription(bug.id, tx),
    );
    if (!isStillAsFiled(bug, filedBody)) return { status: 'skipped', reason: 'card-changed' };

    try {
      // AS THE BINDER, through the gated write path — every rule the tree
      // enforces runs, with no bypass and no system context.
      await workItemsService.updateWorkItem(
        bug.id,
        {
          descriptionMd: describedForWrite(answer),
          explanationMd: answer.explanationMd,
          explanationSource: 'ai_draft',
          type: answer.type,
          executor: answer.executor,
          storyPoints: answer.storyPoints,
          estimateMinutes: answer.estimateMinutes,
          // Only when the answer carries one: a null must never clear a
          // difficulty a person set (MOTIR-6135).
          ...(answer.difficulty !== null ? { difficulty: answer.difficulty } : {}),
        },
        binder,
        { expectedUpdatedAt: bug.updatedAt },
      );
    } catch (err) {
      if (err instanceof StaleWorkItemError) return { status: 'skipped', reason: 'card-changed' };
      throw err;
    }
    return { status: 'applied' };
  },
};

/**
 * ONE latest-event read through `withFreshCredential` — `null` on ANY failure (a
 * refused or degraded credential, a timeout, a gone issue). Never inside a
 * transaction. An enrichment's failure must never be louder than the filing it
 * enriches.
 */
async function readLatestEventQuietly(
  installationRowId: string,
  externalIssueId: string,
): Promise<NormalizedMonitorIssueContext | null> {
  try {
    return await monitorCredentialService.withFreshCredential(installationRowId, (credential) =>
      getMonitorProvider(credential.provider).getIssueContext({
        accessToken: credential.token,
        orgSlug: credential.orgSlug ?? '',
        externalIssueId,
      }),
    );
  } catch {
    return null;
  }
}
