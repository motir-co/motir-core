import type { Prisma } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import type {
  GitProviderId,
  NormalizedChangeRequest,
  NormalizedStatusEvent,
} from '@/lib/git/types';
import { withSystemContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { changeRequestChecksUrl } from '@/lib/git/checksUrl';
import { enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import {
  syncChangeRequestStatus,
  type ChangeRequestContextResolution,
  type ChangeRequestSyncResult,
} from './changeRequestStatusSync';
import {
  applyCiStatusFeedback,
  type CiFeedbackContextResolution,
  type CiFeedbackResult,
} from './changeRequestCiFeedback';
import {
  repoDeploymentService,
  type RecordDeploymentOutcome,
} from '@/lib/services/repoDeploymentService';

// gitlabWebhookService (Story 7.23 · MOTIR-1475) — the inbound GitLab webhook
// logic layer, the GitLab mirror of `githubWebhookService`'s status sync. The HTTP
// route (`app/api/gitlab/webhook`) owns ONLY token verification + dispatch; ALL
// logic is here (CLAUDE.md 4-layer). A GitLab MERGE-REQUEST hook is normalized
// through the shared `GitProvider` seam and driven through THE shared status-sync
// state machine (`changeRequestStatusSync`) — the SAME consumer GitHub uses, not a
// GitLab-specific copy (the card's "no divergent second sync path"). GitLab differs
// only in how it resolves the connection + repo (by the project id, since a GitLab
// hook carries no Motir connection id) and in having no bound-identity table (the
// author is always the workspace owner).
//
// Scope: this service dispatches GitLab's MERGE-REQUEST hook to the shared status
// sync (MOTIR-1475), its PIPELINE hook to the shared CI-feedback consumer
// (`applyCiStatusFeedback`, MOTIR-1477), and its PUSH hook to the code-graph feed
// (MOTIR-1476) — the SAME consumers GitHub drives, not GitLab-specific copies. Each
// sibling card extended this one dispatcher additively; every other kind (note / … )
// stays a fast 2xx no-op.

const PROVIDER: GitProviderId = 'gitlab';

/** GitLab MR actions that drive the status machine. Other `object_attributes.action`
 *  values (`update` — a title edit / new commits / label change / assignee change,
 *  `approved`, `unapproved`) carry no lifecycle change to sync — the GitLab
 *  analogue of GitHub's ignored `synchronize`.
 *
 *  ⚠️ `update` IS STILL ABSENT AND MUST STAY ABSENT (MOTIR-5001). The moment a
 *  draft MR is marked READY arrives under that action, and the fix is NOT to add
 *  it here: membership in this set is a per-DELIVERY gate, so an `update` member
 *  would run the status sync on every push, label and assignee change in every
 *  connected GitLab project — precisely the per-push cost GitHub's `synchronize`
 *  exclusion is reasoned out to avoid. The un-draft moment is admitted by a
 *  PREDICATE over the delivery instead (`clearedDraftFlag` below), which fires at
 *  most once per merge request. */
const HANDLED_MR_ACTIONS = new Set(['open', 'reopen', 'close', 'merge']);

/** The GitLab MR action that carries an un-draft — and, indistinguishably, every
 *  push / label / assignee / title edit. It is admitted ONLY by `clearedDraftFlag`. */
const UPDATE_MR_ACTION = 'update';

/** GitLab's own draft-title prefixes, as its `MergeRequest::DRAFT_REGEX` spells
 *  them. `WIP:` / `[WIP]` were the pre-14.0 spelling and are still what a
 *  sufficiently old self-hosted instance emits, so they are read as well as
 *  written — this is a detector, never a formatter. */
const DRAFT_TITLE_PREFIX = /^\s*(\[draft\]|\(draft\)|draft:|\[wip\]|\(wip\)|wip:)/i;

/**
 * Did THIS delivery clear the merge request's draft flag?
 *
 * ⚠️ THE QUESTION IS ABOUT THE TRANSITION, NOT THE STATE, and that is the whole
 * reason it is answered here rather than on the seam. `NormalizedChangeRequest`
 * carries what the merge request IS (`draft: false` at this moment) and has no
 * notion of what CHANGED — and a delivery whose title was edited while the MR was
 * already ready normalizes to exactly the same shape as this one. Only GitLab's
 * `changes` object separates them, and it never crosses the seam.
 *
 * TWO tells, in priority order:
 *
 *  1. **`changes.draft`** — the modern payload, and AUTHORITATIVE in both
 *     directions. `{ previous: true, current: false }` is the un-draft; a
 *     `{ previous: false, current: true }` (ready → draft) is NOT the inverse rung
 *     and must transition nothing, so its presence is what stops the title tell
 *     below from being consulted at all.
 *  2. **`changes.title`, only when `changes.draft` is absent** — the legacy tell.
 *     Before GitLab surfaced `draft` in the changes object, removing the `Draft: `
 *     prefix WAS the un-draft, and it arrived as an ordinary title change. A
 *     self-hosted instance lags the SaaS release by arbitrary amounts, so this arm
 *     is not dead code on a schedule — it is the only tell some deployments emit.
 */
function clearedDraftFlag(body: Record<string, unknown>): boolean {
  const changes = asRecord(body['changes']);
  if (!changes) return false;

  const draftChange = asRecord(changes['draft']);
  if (draftChange) return draftChange['previous'] === true && draftChange['current'] === false;

  const titleChange = asRecord(changes['title']);
  if (!titleChange) return false;
  const previous = titleChange['previous'];
  const current = titleChange['current'];
  if (typeof previous !== 'string' || typeof current !== 'string') return false;
  return DRAFT_TITLE_PREFIX.test(previous) && !DRAFT_TITLE_PREFIX.test(current);
}

/** Does this delivery carry a lifecycle change worth driving the status machine
 *  with? Either its action is one of the four that always do, or it is the
 *  `update` that un-drafted the merge request (MOTIR-5001). */
function carriesLifecycleChange(action: string, body: Record<string, unknown>): boolean {
  if (HANDLED_MR_ACTIONS.has(action)) return true;
  return action === UPDATE_MR_ACTION && clearedDraftFlag(body);
}

export type GitlabWebhookResult =
  | { event: 'ignored'; reason: string }
  | ChangeRequestSyncResult
  | CiFeedbackResult
  | {
      // Preview deployments (Story MOTIR-4906 · MOTIR-5332) — the same outcome set
      // GitHub's `deployment_status` returns, minus the installation arm GitLab's
      // connection-less hook cannot have.
      event: 'deployment_status';
      outcome: RecordDeploymentOutcome | 'malformed';
    }
  | {
      event: 'push';
      outcome:
        | 'refresh_enqueued' // a default-branch push → the incremental refresh job is queued
        | 'ignored_ref' // a non-branch push (tag / delete), or a non-default branch — no refresh
        | 'unknown_repo'; // the pushed project isn't connected in any workspace
    };

export const gitlabWebhookService = {
  /**
   * Handle one verified delivery. `eventType` is the `X-Gitlab-Event` header; the
   * body's `object_kind` is the authoritative event discriminator GitLab always
   * carries. A `merge_request` hook drives the status sync, a `pipeline` hook the
   * CI-feedback loop, and a `push` hook the code-graph feed; every other kind
   * (note / … ) is a fast 2xx no-op here. Idempotent under redelivery via the
   * shared consumers (the refresh job is idempotent + debounced).
   */
  async handleEvent(eventType: string, payload: unknown): Promise<GitlabWebhookResult> {
    const body = asRecord(payload);
    if (!body) return { event: 'ignored', reason: 'malformed_body' };
    if (body['object_kind'] === 'merge_request') return this.handleMergeRequest(body);
    if (body['object_kind'] === 'pipeline') return this.handlePipeline(body);
    if (body['object_kind'] === 'push') return this.handlePush(body);
    if (body['object_kind'] === 'deployment') return this.handleDeployment(body);
    const kind = typeof body['object_kind'] === 'string' ? body['object_kind'] : eventType;
    return { event: 'ignored', reason: `unhandled_event:${kind || 'unknown'}` };
  },

  /**
   * Handle a `merge_request` hook — normalize it through the seam, gate on the
   * lifecycle-changing MR actions, and drive the linked work item through THE
   * shared status-sync state machine. Opened → In Review; merged → Done;
   * closed-unmerged → In Progress (the abandoned-work signal). A hook for an
   * unconnected project resolves to `unknown_repo` (a clean no-op).
   *
   * ⚠️ AN OPEN DRAFT MR CARRIES NO LIFECYCLE (MOTIR-4968), exactly as on GitHub —
   * the shared seam decides that, not this dispatcher, so nothing here reads
   * `draft`. A draft MR that is closed or merged still carries a real lifecycle.
   *
   * ⚠️ THE UN-DRAFT MOMENT IS GITLAB-SHAPED, AND IT IS A PREDICATE RATHER THAN A
   * SET MEMBER (MOTIR-5001). GitHub emits a dedicated `ready_for_review` action, so
   * its half is one entry in `HANDLED_PR_ACTIONS`. GitLab has no such action: a
   * draft becoming ready is an `update`, which is also what it emits for a pushed
   * commit, a label, an assignee and a title edit — the event we want is buried in
   * the event we most want to ignore. So the gate admits `update` ONLY when this
   * delivery's `changes` object says the draft flag was cleared, which fires at
   * most once per merge request; the whole action stays out of the set.
   *
   * Nothing further is owed once the gate lets it through: at that moment the MR's
   * own `draft` is already `false` and its state is still `opened`, so the shared
   * seam resolves `implemented` on its own. The fix is a GATE, not a new signal.
   */
  async handleMergeRequest(body: Record<string, unknown>): Promise<GitlabWebhookResult> {
    const action = asRecord(body['object_attributes'])?.['action'];
    if (typeof action === 'string' && !carriesLifecycleChange(action, body)) {
      return { event: 'pull_request', outcome: 'ignored_action' };
    }
    const provider = getGitProvider(PROVIDER);
    const cr = provider.parseChangeRequestEvent(body);
    if (!cr) return { event: 'pull_request', outcome: 'malformed' };
    const lifecycle = provider.changeRequestLifecycle(cr);
    return syncChangeRequestStatus(cr, lifecycle, (tx) =>
      resolveGitlabChangeRequestContext(cr, tx),
    );
  },

  /**
   * Handle a `pipeline` hook — the CI feedback half of the loop (MOTIR-1477).
   * Normalize it through the seam (a GitLab pipeline `status` → our CI conclusion;
   * the associated MR iid + branch are the resolver keys) and drive the linked
   * work item's verification feedback through THE shared consumer
   * (`applyCiStatusFeedback`) — the SAME path GitHub's `check_suite`/`check_run`
   * uses. A pipeline for an unconnected project resolves to `unknown_repo` (a clean
   * no-op); a pipeline with no linked MR / work item is a clean no-op too.
   */
  async handlePipeline(body: Record<string, unknown>): Promise<GitlabWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const event = provider.parseCiStatusEvent(body);
    if (!event) return { event: 'ci', outcome: 'malformed' };
    return applyCiStatusFeedback(event, (tx) => resolveGitlabCiContext(event, tx));
  },

  /**
   * Handle a `deployment` hook — the PREVIEW URL a GitLab project's CI reported
   * (Story MOTIR-4906 · MOTIR-5332). Normalized through the same seam method
   * GitHub implements and written by the SAME `repoDeploymentService.record`, so
   * the out-of-order guard, the re-delivery rule and the http(s)-only URL rule are
   * one implementation for both hosts. The project resolves by
   * `(providerRepoId, 'gitlab')`, as the MR / pipeline / push handlers do.
   *
   * ⚠️ READ-ONLY TOWARD THE HOST: no GitLab API call is made on this path.
   */
  async handleDeployment(body: Record<string, unknown>): Promise<GitlabWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const event = provider.parseDeploymentStatusEvent?.(body) ?? null;
    if (!event) return { event: 'deployment_status', outcome: 'malformed' };
    const outcome = await repoDeploymentService.record(PROVIDER, event, (tx) =>
      githubRepoRepository.findByRepoIdAndProvider(event.providerRepoId, PROVIDER, tx),
    );
    return { event: 'deployment_status', outcome };
  },

  /**
   * Handle a `push` hook — the incremental code-graph feed trigger (MOTIR-1476),
   * the GitLab mirror of `githubWebhookService.handlePush` (MOTIR-893). A push to a
   * connected project's DEFAULT branch enqueues the debounced
   * `system.code-graph-refresh` job (best-effort, POST-tx) and returns immediately
   * — the fetch + re-index run in the background job through the SAME
   * provider-agnostic indexer GitHub feeds (`codeGraphIndexService` dispatches by
   * the stored `provider`), never inline in the delivery, so the 2xx stays fast.
   * Any other ref (a feature branch, a tag, a branch deletion) is a clean no-op:
   * the graph tracks what SHIPPED, and a merged MR lands on the default branch as a
   * push, so this one trigger also covers "refresh on merge" (the card's
   * "on push/MR") without a second, coalescing-duplicate hook — exactly as GitHub.
   * A GitLab push hook carries the project id but no Motir connection id, so the
   * connected repo (and its parent installation, whose `installationId` mints the
   * GitLab token) resolves by `(providerRepoId, 'gitlab')`, the same key the MR /
   * pipeline handlers use.
   */
  async handlePush(body: Record<string, unknown>): Promise<GitlabWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const push = provider.parsePushEvent(body);
    // Not a branch push we refresh on (tag / delete / malformed) — a fast no-op.
    if (!push) return { event: 'push', outcome: 'ignored_ref' };

    // Resolve the connected repo + its installation under system context (the
    // webhook has no active workspace, like the MR/pipeline resolvers; reads only).
    const repo = await withSystemContext((tx) =>
      githubRepoRepository.findByRepoIdAndProvider(push.providerRepoId, PROVIDER, tx),
    );
    if (!repo) return { event: 'push', outcome: 'unknown_repo' };

    // Only the STORED default branch feeds the graph — the graph mirrors the repo's
    // shipped mainline, per tenant, per repo (the N-repo cardinality). A push to any
    // other branch is a clean no-op.
    if (push.branch !== repo.defaultBranch) return { event: 'push', outcome: 'ignored_ref' };

    // POST-tx, best-effort: the ack never hinges on the queue (the enqueue swallows
    // + logs a transport failure). The job re-fetches the default branch's CURRENT
    // head at run time, so debounced/coalesced pushes index the newest state once.
    await enqueueCodeGraphRefresh({
      installationId: repo.installation.installationId,
      // The repo row's own tenancy (MOTIR-1931). A GitLab connection is never
      // shared, so this equals the connection's workspace — but the nullable
      // column on the installation is what forces the honest read, and the shared
      // GitHub path needs exactly this shape.
      workspaceId: repo.workspaceId,
      repoOwner: repo.owner,
      repoName: repo.name,
      defaultBranch: repo.defaultBranch,
    });
    return { event: 'push', outcome: 'refresh_enqueued' };
  },
};

/** Resolve the GitLab connection + repo for a merge-request event — the
 *  provider-specific half the shared status sync needs. A GitLab hook carries the
 *  project id but no Motir connection id, so resolve the connected repo by
 *  `(provider, projectId)` → its parent installation. GitLab has no bound-identity
 *  table, so the author is always null (→ the shared sync's workspace-owner
 *  fallback). `unknown_repo` when the project isn't connected in any workspace. */
async function resolveGitlabChangeRequestContext(
  cr: NormalizedChangeRequest,
  tx: Prisma.TransactionClient,
): Promise<ChangeRequestContextResolution> {
  const repo = await githubRepoRepository.findByRepoIdAndProvider(cr.providerRepoId, PROVIDER, tx);
  if (!repo) return { kind: 'unknown_repo' };
  return { kind: 'resolved', installation: repo.installation, repo, authorBoundUserId: null };
}

/** Resolve the GitLab connection + repo + checks-URL builder for a pipeline event —
 *  the provider-specific half the shared CI-feedback consumer needs. Keys on the
 *  project id (a GitLab hook carries no Motir connection id, exactly as the MR
 *  resolver does); the checks link points at the MR's pipelines tab on the GitLab
 *  host. `unknown_repo` when the project isn't connected in any workspace. */
async function resolveGitlabCiContext(
  event: NormalizedStatusEvent,
  tx: Prisma.TransactionClient,
): Promise<CiFeedbackContextResolution> {
  const repo = await githubRepoRepository.findByRepoIdAndProvider(
    event.providerRepoId,
    PROVIDER,
    tx,
  );
  if (!repo) return { kind: 'unknown_repo' };
  return {
    kind: 'resolved',
    installation: repo.installation,
    repo,
    buildChecksUrl: (number) => changeRequestChecksUrl('gitlab', repo, number),
  };
}

/** Narrow an `unknown` webhook body to a plain object (defensive read over the
 *  untyped JSON). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
