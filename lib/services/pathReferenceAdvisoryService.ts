import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { repoFileReadService } from '@/lib/services/repoFileReadService';
import { listConnectedRepoNames } from '@/lib/workItems/targetRepo';
import {
  bodyNamedFilePaths,
  criterionFilePaths,
  forwardReferenceRepo,
  sharesRepository,
  topLevelDirectory,
  type PathPresence,
} from '@/lib/workItems/pathReference';
import type { WorkItemPathReferenceAdvisoryDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE PATH-REFERENCE advisory (MOTIR-5424) — the service half. The rule, and why
// each of its four clauses is there, is in `lib/workItems/pathReference.ts`.
//
// Three reads, in the order that makes the common subtree pay for none of them:
//  1. the OTHER NAMERS — one project-scoped body read, only when some scanned
//     card's criteria name a file path at all;
//  2. the ORDERING — ancestor chains and `blocked_by` edges for the cards that
//     survived (1), in two batched reads;
//  3. the HOST — whether each surviving path, and its top-level directory,
//     exists on the default branch. Last, because it is the only one that
//     leaves the database, and by then the set is the handful the sweep measured
//     (12 multi-namer paths over 520 open work items), not every path a body names.

/**
 * Whether `path` exists on the default branch of the repository NAMED `repo`
 * (the bare name a work item's `targetRepos` carries). Injected so the decision
 * can be exercised without a repository host; the shipped answer is
 * {@link hostPathResolver}.
 */
export type PathResolver = (repo: string, path: string) => Promise<PathPresence>;

/**
 * The shipped resolver: `repoFileReadService.readFile` at the stored default
 * branch, through the organisation's connected repositories.
 *
 * `found`, `binary` and `too_large` are PRESENT — the last two are files the
 * read will not return as text, which exist all the same — and so is `directory`, which the
 * top-level-directory clause asks about (it read as `found` until the read named directories,
 * MOTIR-9868). `not_found` is ABSENT. Every other outcome —
 * a repository not connected, a revoked App, a missing ref, a timeout — is
 * UNKNOWN, and an unknown silences the finding (`forwardReferenceRepo`).
 *
 * The connected-repository list is read once per resolver, on the first
 * question; the questions themselves are de-duplicated by the caller.
 */
export function hostPathResolver(ctx: ServiceContext): PathResolver {
  let refs: Promise<Map<string, string>> | null = null;
  const repoRefs = () =>
    (refs ??= listConnectedRepoNames(ctx).then(
      (repos) => new Map(repos.map((r) => [r.name.toLowerCase(), r.repoRef])),
    ));
  return async (repo, path) => {
    const repoRef = (await repoRefs()).get(repo.toLowerCase());
    if (!repoRef) return 'unknown';
    const read = await repoFileReadService.readFile(ctx, repoRef, path);
    if (
      read.outcome === 'found' ||
      read.outcome === 'binary' ||
      read.outcome === 'too_large' ||
      read.outcome === 'directory'
    ) {
      return 'present';
    }
    if (read.outcome === 'not_found') return 'absent';
    return 'unknown';
  };
}

/**
 * How many distinct paths the other-namers read is asked about. A cap on
 * UNBOUNDED input — a validated epic can hold a hundred cards — in the spirit of
 * `MAX_SUBSUMPTION_QUERY_PATHS`; hitting it can only MISS an advisory on a
 * channel that never blocks, never produce a wrong one.
 */
export const MAX_PATH_REFERENCE_PATHS = 200;

/**
 * How many host reads one validation may make. Each is a network round-trip on a
 * read path; two per surviving path (the file and its top-level directory, the
 * second usually shared). Past the cap the remaining paths are not asked about —
 * again a miss, never a false finding.
 */
export const MAX_PATH_REFERENCE_HOST_READS = 40;

/** One scanned card — a NOT-done member of the validated subtree. */
export interface PathReferenceSubject {
  id: string;
  identifier: string;
  descriptionMd: string | null;
  /** The repositories it ships in; a card carrying none is skipped (nothing to resolve against). */
  targetRepos: readonly string[];
}

interface Candidate {
  subject: PathReferenceSubject;
  path: string;
  criterionIndex: number;
  namer: { id: string; identifier: string; status: string };
}

/**
 * Build the path-reference advisories for the scanned cards of ONE project.
 *
 * `terminalStatusKeys` is the project's done category, already in the caller's
 * hand — a second namer that is `done` has either created the file (then it
 * resolves) or never will, and neither is a missing edge.
 *
 * ⚠️ ADVISORY, NEVER A BLOCKER — the caller appends this to `advisories` and
 * computes `valid` / `blockers` without it.
 */
export async function buildPathReferenceAdvisories(
  subjects: readonly PathReferenceSubject[],
  projectId: string,
  terminalStatusKeys: ReadonlySet<string>,
  ctx: ServiceContext,
  resolvePath: PathResolver = hostPathResolver(ctx),
): Promise<WorkItemPathReferenceAdvisoryDto[]> {
  // What each scanned card's criteria name. A card pinning no repository is
  // skipped outright: clause (2) is a question about ITS repository.
  const named = subjects.flatMap((subject) =>
    subject.targetRepos.length === 0
      ? []
      : criterionFilePaths(subject.descriptionMd).map((p) => ({ subject, ...p })),
  );
  const paths = [...new Set(named.map((n) => n.path))].slice(0, MAX_PATH_REFERENCE_PATHS);
  if (paths.length === 0) return [];

  // (1) THE OTHER NAMERS. The substring read over-matches; each body is re-read
  // with the same extraction and kept only on an exact path.
  const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findLiveBodiesContainingAny(projectId, ctx.workspaceId, paths, tx, [
      ...terminalStatusKeys,
    ]),
  );
  const openNamers = rows
    .filter((row) => !terminalStatusKeys.has(row.status))
    .map((row) => ({ row, paths: bodyNamedFilePaths(row.descriptionMd) }));
  const wanted = new Set(paths);
  const candidates: Candidate[] = [];
  for (const n of named) {
    if (!wanted.has(n.path)) continue;
    for (const { row, paths: rowPaths } of openNamers) {
      if (row.id === n.subject.id || !rowPaths.has(n.path)) continue;
      if (!sharesRepository(n.subject.targetRepos, row.targetRepos)) continue;
      candidates.push({
        subject: n.subject,
        path: n.path,
        criterionIndex: n.criterionIndex,
        namer: { id: row.id, identifier: row.identifier, status: row.status },
      });
    }
  }
  if (candidates.length === 0) return [];

  // (2) THE ORDERING. Two cards are ordered when either chain — the card and its
  // ancestors — carries a `blocked_by` into the other's chain: gate 7 puts a
  // cross-story edge BETWEEN THE STORIES, so a leaf-only test would report every
  // correctly wired pair in two stories. And a card naming a file its own
  // ancestor or descendant also names is one piece of work describing itself.
  const ids = [...new Set(candidates.flatMap((c) => [c.subject.id, c.namer.id]))];
  const { chains, edges } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const ancestors = await workItemRepository.findAncestorIdsForItems(ids, ctx.workspaceId, tx);
    const chains = new Map(ids.map((id) => [id, new Set([id, ...(ancestors.get(id) ?? [])])]));
    const members = [...new Set([...chains.values()].flatMap((c) => [...c]))];
    const edges = await workItemLinkRepository.findBlockerEdgesForItems(
      members,
      ctx.workspaceId,
      tx,
    );
    return { chains, edges };
  });
  const blockedBy = new Map<string, Set<string>>();
  for (const e of edges) {
    const set = blockedBy.get(e.fromId);
    if (set) set.add(e.blockerId);
    else blockedBy.set(e.fromId, new Set([e.blockerId]));
  }
  const edgeBetween = (from: ReadonlySet<string>, to: ReadonlySet<string>): boolean =>
    [...from].some((f) => [...(blockedBy.get(f) ?? [])].some((b) => to.has(b)));
  const unordered = candidates.filter((c) => {
    const mine = chains.get(c.subject.id) as Set<string>;
    const theirs = chains.get(c.namer.id) as Set<string>;
    if (mine.has(c.namer.id) || theirs.has(c.subject.id)) return false;
    return !edgeBetween(mine, theirs) && !edgeBetween(theirs, mine);
  });
  if (unordered.length === 0) return [];

  // (3) THE HOST — only for what survived, each question asked once, and at most
  // MAX_PATH_REFERENCE_HOST_READS of them.
  const questions = new Map<string, { repo: string; path: string }>();
  for (const c of unordered) {
    for (const repo of c.subject.targetRepos) {
      for (const path of [c.path, topLevelDirectory(c.path)]) {
        const key = `${repo.toLowerCase()}:${path}`;
        if (!questions.has(key) && questions.size < MAX_PATH_REFERENCE_HOST_READS) {
          questions.set(key, { repo, path });
        }
      }
    }
  }
  const answers = new Map(
    await Promise.all(
      [...questions].map(async ([key, q]) => [key, await resolvePath(q.repo, q.path)] as const),
    ),
  );
  const presence = (repo: string, path: string): PathPresence =>
    answers.get(`${repo.toLowerCase()}:${path}`) ?? 'unknown';

  const advisories: WorkItemPathReferenceAdvisoryDto[] = [];
  for (const c of unordered) {
    const repo = forwardReferenceRepo(
      c.subject.targetRepos.map((r) => ({
        repo: r,
        path: presence(r, c.path),
        directory: presence(r, topLevelDirectory(c.path)),
      })),
    );
    if (repo === null) continue;
    advisories.push({
      kind: 'path-reference',
      item: c.subject.identifier,
      severity: 'likely-missing-path-edge',
      path: c.path,
      criterionIndex: c.criterionIndex,
      repo,
      referenced: c.namer.identifier,
      referencedStatus: c.namer.status,
    });
  }
  // Deterministic wire order: by card, then path, then the other namer.
  advisories.sort(
    (a, b) =>
      a.item.localeCompare(b.item) ||
      a.path.localeCompare(b.path) ||
      a.referenced.localeCompare(b.referenced),
  );
  return advisories;
}
