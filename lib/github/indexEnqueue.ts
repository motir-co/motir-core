import { sendSystemEvent } from '@/lib/jobs/sendEvent';
import type {
  CodeGraphIndexData,
  CodeGraphPrHeadIndexData,
  CodeGraphRefreshData,
} from '@/lib/jobs/types';
import type { NormalizedRepo } from '@/lib/git/types';

// Best-effort, POST-COMMIT enqueue of the `system.code-graph-index` job for a
// NEWLY-ADDED GitHub repo (Story 7.5 · MOTIR-1500). The single chokepoint both
// repo-add paths call — the webhook reconcile (`installation` /
// `installation_repositories`) and the fresh-install bind — so the fetch + the
// motir-ai handoff always run in the background job, never inline in the request.
//
// MUST be called AFTER the installation's repos persist: the grant mirror is the
// source of truth and the index is a SIDE EFFECT that must never fail or roll
// back the grant (PROD-443 — coupling a committed mutation to a transport call
// turns it into a 500 on a blip). So a failed enqueue is swallowed + logged.
//
// SELF-HEALING — what it does and does not cover (MOTIR-1961). The dispatch gate
// is "this repo has NO code graph yet", NOT "this repo row is new", so a dropped
// enqueue really does self-heal on the next repo-selection change or re-bind: the
// repo still has no succeeded index, so the next reconcile enqueues it again. The
// gate USED to be row novelty (`existingRepoIds`), and that made the self-heal
// claim false for the one case that needed it most — a repo persisted BEFORE this
// feature shipped was never "newly added" at any moment when the code existed, so
// no bind, no reconcile and no refresh ever gave it a first graph, and the
// workspace was silently code-blind forever. Novelty and indexedness are different
// facts; only the second one belongs in this gate.

/** A repo's canonical `owner/name` ref — the key the index ledger records as
 *  `output.repoRef` and the one the enqueue gate matches against. Kept here, next
 *  to the gate, so the producer and the consumer of that key cannot drift. */
export function repoRefOf(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

/** Enqueue ONE repo's index job. Swallows + logs a transport failure — that
 *  policy now lives in `sendSystemEvent` rather than being restated here
 *  (MOTIR-3456), which is also what puts the event through the cutover switch. */
export async function enqueueCodeGraphIndex(data: CodeGraphIndexData): Promise<void> {
  await sendSystemEvent('system.code-graph-index', data);
}

/**
 * What asked for a refresh (MOTIR-5360): a default-branch `push`, or a planning
 * session that started on a stale graph (`session_start`).
 *
 * Since MOTIR-11884 it no longer changes WHEN the run is due: the refresh job has
 * no debounce, so every refresh is due the moment it is enqueued, whatever asked
 * for it. The option is kept so no caller changes. What makes a push hand off as a
 * `push` is the payload's `refreshCause`, which the push webhooks set.
 */
export type CodeGraphRefreshTrigger = 'push' | 'session_start';

/**
 * Enqueue ONE repo's REFRESH job (MOTIR-893) — the graph should re-index.
 * Best-effort like the index enqueue: the webhook 2xx must never hinge on the
 * queue, so a transport failure is swallowed + logged (the job is idempotent and
 * the next push re-enqueues, so a dropped refresh self-heals). Due at once.
 */
export async function enqueueCodeGraphRefresh(
  data: CodeGraphRefreshData,
  // Kept for its callers; it no longer changes when the run is due (MOTIR-11884).
  _opts: { trigger?: CodeGraphRefreshTrigger } = {},
): Promise<void> {
  await sendSystemEvent('system.code-graph-refresh', data);
}

/**
 * Enqueue ONE same-repository pull request's HEAD index (MOTIR-12257). Best-effort
 * like its two siblings: the webhook 2xx never hinges on the queue, and the next
 * `synchronize` re-enqueues, so a dropped run self-heals at the next push.
 */
export async function enqueueCodeGraphPrHeadIndex(data: CodeGraphPrHeadIndexData): Promise<void> {
  await sendSystemEvent('system.code-graph-pr-head-index', data);
}

/**
 * Enqueue an index job for each repo in `repos` that has NO code graph yet —
 * `indexedRepoRefs` is the workspace's already-indexed set (`owner/name`, from
 * the succeeded-index ledger). A reconcile whose repos are all indexed enqueues
 * nothing; a repo that is merely UNCHANGED but has never been indexed DOES
 * enqueue, which is the whole point (MOTIR-1961).
 *
 * A repo whose index is queued or in flight but not yet succeeded re-enqueues.
 * That is deliberate and cheap to allow: the ledger cannot tie a `running` row to
 * a repo (it writes `output.repoRef` only on success), the job is idempotent by
 * construction, and the reconcile that would double-send fires only on a
 * repo-selection change. Under-enqueueing here costs a permanently code-blind
 * workspace; over-enqueueing costs one convergent re-index.
 *
 * Best-effort per repo (one failure never blocks the others or the caller).
 */
export async function enqueueReposMissingFirstIndex(input: {
  installationId: string;
  workspaceId: string;
  repos: NormalizedRepo[];
  indexedRepoRefs: Iterable<string>;
}): Promise<void> {
  const indexed = new Set(input.indexedRepoRefs);
  for (const repo of input.repos) {
    if (indexed.has(repoRefOf(repo))) continue;
    await enqueueCodeGraphIndex({
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      repoOwner: repo.owner,
      repoName: repo.name,
      defaultBranch: repo.defaultBranch,
    });
  }
}
