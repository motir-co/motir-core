import { enqueueCodeGraphPrHeadIndex } from '@/lib/github/indexEnqueue';
import { asRecord, logRef, nonEmpty, readId, resolveDeliveryScope } from './githubDeliveryScope';

// THE GITHUB → PULL-REQUEST HEAD INDEX (MOTIR-12257 · story MOTIR-12250) — a third
// listener on the `pull_request` delivery, after the delivery's own handling and the
// code-graph forward (`githubCodeGraphForwardService`).
//
//   opened / reopened / synchronize, for an OPEN pull request whose head is in the
//   SAME repository and is not the default branch → ONE
//   `system.code-graph-pr-head-index` run, which reads the head live and hands it
//   to motir-ai (`lib/jobs/definitions/codeGraphPrHeadIndex.ts`)
//
// Everything else is skipped with an outcome and no enqueue. A push to a branch with
// no pull request never reaches here: `handlePush` answers it `ignored_ref`, and this
// card adds nothing to the push path.
//
// ⚠️ IT RUNS AFTER THE DELIVERY'S EXISTING HANDLING, from `handleEvent`, and cannot
// change its result. Every path here is caught and logged: a webhook ack must never
// fail because of an index.
//
// ⚠️ NO SHA IS ENQUEUED. The run reads the head from the host, so the delivery's
// `head.sha` is never authority for what is handed off.

/** What the listener did; for tests and the log, never part of the delivery's answer. */
export type PrHeadIndexOutcome =
  | 'enqueued'
  | 'ignored_action'
  | 'fork_head'
  | 'not_open'
  | 'default_branch_head'
  | 'unknown_installation'
  | 'unknown_repo'
  | 'malformed'
  | 'failed';

const INDEXED_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);

export const githubPrHeadIndexService = {
  /** A `pull_request` delivery: ONE head index for a same-repository open pull request, or nothing. */
  async onPullRequest(body: Record<string, unknown>): Promise<PrHeadIndexOutcome> {
    try {
      const action = body['action'];
      if (typeof action !== 'string' || !INDEXED_ACTIONS.has(action)) return 'ignored_action';
      const pr = asRecord(body['pull_request']);
      const head = asRecord(pr?.['head']);
      const repositoryId = readId(asRecord(body['repository'])?.['id']);
      const headRepoId = readId(asRecord(head?.['repo'])?.['id']);
      // A deleted fork's `head.repo` is null; a fork's is another repository.
      if (!repositoryId || headRepoId !== repositoryId) return 'fork_head';
      if (pr?.['state'] !== 'open') return 'not_open';

      const headRef = head?.['ref'];
      const baseRef = asRecord(pr['base'])?.['ref'];
      const number = pr['number'];
      if (
        !nonEmpty(headRef) ||
        !nonEmpty(baseRef) ||
        !Number.isInteger(number) ||
        (number as number) < 1
      ) {
        console.warn(
          `[githubPrHeadIndex] pull_request for ${logRef(body)} indexed nothing: no head ref, base ref or number`,
        );
        return 'malformed';
      }

      const scope = await resolveDeliveryScope(body, repositoryId);
      if (scope.kind !== 'resolved') return scope.kind;
      // The default branch's head is the default-branch run's, from its push.
      if (headRef === scope.defaultBranch) return 'default_branch_head';

      await enqueueCodeGraphPrHeadIndex({
        installationId: scope.installationId,
        workspaceId: scope.workspaceId,
        repoOwner: scope.owner,
        repoName: scope.name,
        defaultBranch: scope.defaultBranch,
        pullRequestNumber: number as number,
        headRef,
        baseRef,
      });
      return 'enqueued';
    } catch (err) {
      console.error(
        `[githubPrHeadIndex] pull_request for ${logRef(body)} indexed nothing:`,
        err instanceof Error ? err.message : String(err),
      );
      return 'failed';
    }
  },
};
