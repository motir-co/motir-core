import { repoRefOf } from '@/lib/github/indexEnqueue';
import { enqueueCodeGraphForward } from '@/lib/jobs/codeGraphForward';
import type { CodeGraphForwardData } from '@/lib/jobs/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// THE GITHUB → CODE-GRAPH FORWARD (MOTIR-12056 · story MOTIR-11870) — a second
// listener on two webhook deliveries, beside the handling they already get.
//
//   pull_request  opened / reopened → state `open`
//                 closed            → `merged` (with `mergedAt`) or `closed`
//                 head in the SAME repository only — a fork's branch is not one
//                 motir-codegraph holds
//   push          `deleted: true` on `refs/heads/<branch>` → retire `<branch>`
//
// Each enqueues AT MOST ONE `system.code-graph-forward` run, which owns every retry
// (`lib/jobs/definitions/codeGraphForward.ts`).
//
// ⚠️ IT RUNS AFTER THE DELIVERY'S EXISTING HANDLING, from `handleEvent`, and cannot
// change its result. `handlePullRequest` returns early on `dequeued`, `enqueued` and
// every unhandled action, and `handlePush` answers a delete `ignored_ref` before it
// resolves anything, so a listener inside either would miss deliveries. Every path
// here is caught and logged: a webhook ack must never fail because of a forward.
//
// ⚠️ NO DEFAULT-BRANCH JUDGEMENT. Whether a branch is the default one is the
// service's call; a pull request whose head is the default branch, or a push that
// deletes it, is forwarded like any other and answered by the service.
//
// ⚠️ THE ORGANISATION READ BINDS THE WORKSPACE FIRST, like
// `codeGraphIndexService.resolveIndexTarget`: `workspace`'s policies key on
// `app.workspace_id`, so an unbound read returns null and raises nothing.

/** What one listener did; for tests and the log, never part of the delivery's answer. */
export type CodeGraphForwardOutcome =
  | 'enqueued'
  | 'ignored_action'
  | 'fork_head'
  | 'ignored_ref'
  | 'unknown_installation'
  | 'unknown_repo'
  | 'malformed'
  | 'failed';

const BRANCH_REF = 'refs/heads/';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A GitHub numeric id, as the string the mirror stores it as. */
function readId(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : null;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** An ISO time GitHub wrote, kept as GitHub wrote it, or null when it does not parse. */
function readTime(value: unknown): string | null {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** The repository's name for the log: `owner/name` from the payload, never a token or URL. */
function logRef(body: Record<string, unknown>): string {
  const fullName = asRecord(body['repository'])?.['full_name'];
  return typeof fullName === 'string' ? fullName : '(unknown repository)';
}

/** The stored installation → repository row → workspace → organisation, or why not. */
async function resolveScope(
  body: Record<string, unknown>,
  providerRepoId: string,
): Promise<
  | { kind: 'resolved'; coreOrganizationId: string; repoRef: string }
  | { kind: 'unknown_installation' | 'unknown_repo' }
> {
  const installationId = readId(asRecord(body['installation'])?.['id']);
  if (!installationId) return { kind: 'unknown_installation' };
  return withSystemContext(async (tx) => {
    const installation = await githubInstallationRepository.findByInstallationId(
      installationId,
      tx,
    );
    if (!installation) return { kind: 'unknown_installation' as const };
    const repo = await githubRepoRepository.findByInstallationAndRepoId(
      installation.id,
      providerRepoId,
      tx,
    );
    if (!repo) return { kind: 'unknown_repo' as const };
    await bindWorkspaceContext(tx, repo.workspaceId);
    const workspace = await workspaceRepository.findByIdInTx(repo.workspaceId, tx);
    // A repository row whose workspace is gone holds nothing to forward for.
    if (!workspace) return { kind: 'unknown_repo' as const };
    return {
      kind: 'resolved' as const,
      coreOrganizationId: workspace.organizationId,
      repoRef: repoRefOf({ owner: repo.owner, name: repo.name }),
    };
  });
}

/** One pull request's state, or why the delivery forwards nothing. */
type PullRequestReading =
  | { kind: 'state'; providerRepoId: string; fields: PullRequestFields }
  | { kind: 'skip'; outcome: CodeGraphForwardOutcome; warn?: string };

type PullRequestFields = Pick<
  Extract<CodeGraphForwardData, { kind: 'pull_request_state' }>,
  'ref' | 'pullRequestNumber' | 'state' | 'mergedAt' | 'reportedAt'
>;

function readPullRequest(body: Record<string, unknown>): PullRequestReading {
  const action = body['action'];
  if (action !== 'opened' && action !== 'reopened' && action !== 'closed') {
    return { kind: 'skip', outcome: 'ignored_action' };
  }
  const pr = asRecord(body['pull_request']);
  const head = asRecord(pr?.['head']);
  const repositoryId = readId(asRecord(body['repository'])?.['id']);
  const headRepoId = readId(asRecord(head?.['repo'])?.['id']);
  // A deleted fork's `head.repo` is null; a fork's is another repository.
  if (!repositoryId || headRepoId !== repositoryId) return { kind: 'skip', outcome: 'fork_head' };

  const ref = head?.['ref'];
  const number = pr?.['number'];
  const reportedAt = readTime(pr?.['updated_at']);
  if (!nonEmpty(ref) || !Number.isInteger(number) || (number as number) < 1 || !reportedAt) {
    return { kind: 'skip', outcome: 'malformed', warn: 'no head ref, number or updated_at' };
  }
  const fields: PullRequestFields = {
    ref,
    pullRequestNumber: number as number,
    state: action === 'closed' ? (pr?.['merged'] === true ? 'merged' : 'closed') : 'open',
    reportedAt,
  };
  if (fields.state === 'merged') {
    // A merged report needs its merge time; a guessed `now` would read as a measurement.
    const mergedAt = readTime(pr?.['merged_at']);
    if (!mergedAt) return { kind: 'skip', outcome: 'malformed', warn: 'merged with no merged_at' };
    fields.mergedAt = mergedAt;
  }
  return { kind: 'state', providerRepoId: repositoryId, fields };
}

/** Run one listener: whatever it throws is logged and answered `failed`. */
async function guarded(
  eventType: 'pull_request' | 'push',
  body: Record<string, unknown>,
  listen: () => Promise<CodeGraphForwardOutcome>,
): Promise<CodeGraphForwardOutcome> {
  try {
    return await listen();
  } catch (err) {
    console.error(
      `[githubCodeGraphForward] ${eventType} for ${logRef(body)} forwarded nothing:`,
      err instanceof Error ? err.message : String(err),
    );
    return 'failed';
  }
}

export const githubCodeGraphForwardService = {
  /** A `pull_request` delivery: ONE state report for a same-repository head, or nothing. */
  onPullRequest(body: Record<string, unknown>): Promise<CodeGraphForwardOutcome> {
    return guarded('pull_request', body, async () => {
      const reading = readPullRequest(body);
      if (reading.kind === 'skip') {
        if (reading.warn) {
          console.warn(
            `[githubCodeGraphForward] pull_request for ${logRef(body)} forwarded nothing: ${reading.warn}`,
          );
        }
        return reading.outcome;
      }
      const scope = await resolveScope(body, reading.providerRepoId);
      if (scope.kind !== 'resolved') return scope.kind;
      await enqueueCodeGraphForward({
        kind: 'pull_request_state',
        coreOrganizationId: scope.coreOrganizationId,
        repoRef: scope.repoRef,
        ...reading.fields,
      });
      return 'enqueued';
    });
  },

  /** A `push` delivery: ONE retire for a deleted branch, or nothing. */
  onPush(body: Record<string, unknown>): Promise<CodeGraphForwardOutcome> {
    return guarded('push', body, async () => {
      if (body['deleted'] !== true) return 'ignored_ref';
      const fullRef = body['ref'];
      if (typeof fullRef !== 'string' || !fullRef.startsWith(BRANCH_REF)) return 'ignored_ref';
      const branch = fullRef.slice(BRANCH_REF.length);
      if (branch === '') return 'ignored_ref';
      const repositoryId = readId(asRecord(body['repository'])?.['id']);
      if (!repositoryId) return 'malformed';
      const scope = await resolveScope(body, repositoryId);
      if (scope.kind !== 'resolved') return scope.kind;
      await enqueueCodeGraphForward({
        kind: 'retire',
        coreOrganizationId: scope.coreOrganizationId,
        repoRef: scope.repoRef,
        ref: branch,
      });
      return 'enqueued';
    });
  },
};
