import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getGitProvider, providerSupportsRepoTarballUrl } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import { enqueueCodeGraphRefresh } from '@/lib/github/indexEnqueue';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { isEstablishedState } from '@/lib/projectRepos/vocabulary';
import type { CodeGraphIndexState } from '@/lib/codeGraph/indexState';
import type { CodeRefreshReason } from '@/lib/codeGraph/refreshReason';

// Resolve the CODE half of a planning-job context bag (Subtask 7.10.15 ·
// MOTIR-1598) — the workspace's connected repo SET, read from the persisted
// installation grant mirror (7.10.3 · MOTIR-891). This is the PRODUCER side of
// the `context.code.repos[]` cross-repo contract with motir-ai's multi-repo
// code-graph reads (7.10.16 · MOTIR-1599).
//
// Shared by every PLANNING-job dispatch entry point (`generate_tree` today; the
// augment / expand_item / replan submits adopt it when they land) so the
// resolution lives in one place — the exact shape `resolveTenantOrg` set for the
// org half.
//
// ⚠️ SCOPING IS THE PROJECT'S CONFIGURED REPOSITORY SET (MOTIR-4653 · MOTIR-4642 ·
// the decision is `docs/decisions/code-graph-index-fan-out.md`, MOTIR-2029). It
// used to be the WORKSPACE's installation grant list — every repository anybody
// connected, whether or not this project builds any of it — and this comment
// carried the deferral saying so. That deferral is discharged: `project_repository`
// is the project's repository SET (MOTIR-1780), and which repositories a project
// works on is VISIBILITY CONFIGURATION rather than a property of its workspace.
//
// ⚠️ WHAT THAT NARROWING COSTS, STATED HERE BECAUSE IT IS SILENT. A planner given
// too much code does not fail — it produces a plan that reads fine and is grounded
// in repositories the project does not own. A planner given too little does not
// fail either. So the failure mode on BOTH sides of this line is a worse plan and
// a green pipeline, which is why the set is decided by configuration somebody made
// rather than inferred from a grant somebody else made.
//
// ⚠️ AND IT IS DELIBERATELY NOT THE ONLY QUESTION THIS FILE ANSWERS —
// {@link resolveWorkspaceConnectedRepos} keeps the WORKSPACE-grant read, because
// the onboarding wizard asks a genuinely different question (*has this user
// connected a repository on the host yet?*) and its own step comment says so. That
// question has no project-scoped answer: nothing populates `project_repository`
// during onboarding, so re-pointing it would leave the CONNECT step's gate shut
// for ever. Two readers, two questions, both named.
//
// A DB read ONLY — never a GitHub API round-trip on the submit path. An empty set
// resolves to `undefined` so the caller OMITS `context.code` entirely and a
// start-fresh project's envelope stays byte-identical to a code-less one.

/** One connected repo as it rides the job envelope. */
export interface JobCodeRepo {
  /** The git-provider discriminator (`"github"` today; the GitProvider seam). */
  provider: string;
  /** `owner/name` — the ref motir-ai keys its per-repo code-graph stores on. */
  repoRef: string;
  defaultBranch: string;
  /**
   * HAS THIS REPOSITORY GOT A CODE GRAPH (Story MOTIR-4753 · MOTIR-4826)?
   *
   * ⚠️ A FACT ON THE WIRE, NEVER A DECISION. `motir-core` supplies it exactly as
   * it supplies the ref itself; what an unindexed repository MEANS — whether the
   * person waits, or is onboarded, or plans anyway — is the routing verdict's
   * judgement (`motir-ai` MOTIR-4828), and nothing here may branch on it.
   *
   * ⚠️ AND IT EXISTS BECAUSE THE ALTERNATIVE IS INDISTINGUISHABLE. A session
   * given only the ref sees every code-graph tool answer EMPTY for a repository
   * whose index has not run — which reads exactly like a repository with nothing
   * in it, and the two support opposite verdicts. Read from the SAME succeeded-
   * index ledger the wizard's INDEX step waits on and the onboarding substrate
   * read reports from, so the three cannot disagree.
   */
  indexed: boolean;
  /**
   * HOW CURRENT THAT GRAPH IS (Story MOTIR-1754 · MOTIR-4857) — the four-state
   * derivation and the drift in COMMITS, beside the ledger fact above.
   *
   * ⚠️ OPTIONAL, AND ABSENT MEANS *NOBODY SAID* — never *current*. It stays
   * optional even though the two sets now COINCIDE: since MOTIR-4653 these
   * entries are built from the PROJECT's configured set, which is the same set
   * the freshness is joined from, so the "a repository the project has not been
   * given carries no drift" case this note used to describe can no longer arise.
   * What can still arise is a repository nobody has measured yet, and that is the
   * same three-state discipline `indexed` itself lands under (MOTIR-4826) and the
   * one motir-ai's reader already tolerates — so the absence keeps its meaning
   * and loses one of its two causes.
   *
   * ⚠️ AND THEY DECIDE NOTHING, exactly as `indexed` decides nothing. What a
   * drift of three commits MEANS against a drift of three hundred is the
   * planner's judgement (MOTIR-4590); `motir-core` supplies the number and does
   * not branch on it. A threshold here would put the decision back in the
   * repository that five of this story's cards took it out of.
   */
  indexState?: CodeGraphIndexState;
  /** Commits the default branch is ahead of the graph. `null` = not countable. */
  commitsBehind?: number | null;
  /**
   * THE PAIR THE DRIFT IS ABOUT (MOTIR-10094) — the commit the graph was built
   * from and the default branch's head, `null` while either is unknown. Optional
   * for `indexState`'s reason: absent means nobody said.
   *
   * ⚠️ THEY ARE WHAT MAKE A DRIFT CHECKABLE. A count says how many commits the
   * graph is missing and nothing about WHERE — one squash-merge can be a whole
   * story — so the session is handed the two shas to list the changed paths with
   * (`list_changed_files { repoRef, base: indexedSha, head: defaultHead }`), on
   * demand, rather than a provider compare on the submit path.
   */
  indexedSha?: string | null;
  defaultHead?: string | null;
}

/** The `context.code` unit of a planning-job envelope (the plural contract). */
export interface JobCodeContext {
  repos: JobCodeRepo[];
}

/**
 * THE WORKSPACE'S CONNECTED SET — *what has this user connected on the host?*
 *
 * The read `resolveCodeContext` used to perform, kept under a name that says
 * which question it answers (MOTIR-4653). Its callers are the ONBOARDING paths,
 * and they are not a leftover: the migrate wizard's CONNECT step documents its
 * own exit as *"a connected repository exists for the workspace (the GitHub grant
 * mirror) … the wizard only observes it"*, which is a question about the GRANT and
 * has no project-scoped answer — nothing writes `project_repository` during
 * onboarding, so a project-scoped version of this gate never opens.
 *
 * ⚠️ NOT FOR A PLANNING ENVELOPE. What a planning job may see is the PROJECT's
 * configured set; reach for {@link resolveProjectCodeContext}.
 */
export async function resolveWorkspaceConnectedRepos(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<JobCodeContext | undefined> {
  const { repos, indexedRefs } = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => {
      const installation = await githubInstallationRepository.findByWorkspaceId(
        ctx.workspaceId,
        tx,
      );
      if (!installation) return { repos: [], indexedRefs: [] as string[] };
      const rows = await githubRepoRepository.listByInstallation(installation.id, tx);
      // ⚠️ ONE LEDGER READ FOR THE WHOLE SET, and only when there IS a set — the
      // same shape `readOnboardingSubstrate` uses, and the same read, so the
      // envelope and the reading state can never tell a user two different
      // things about the same repository.
      const indexedRefs =
        rows.length === 0
          ? []
          : await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(ctx.workspaceId, tx);
      return { repos: rows, indexedRefs };
    },
  );
  if (repos.length === 0) return undefined;
  return {
    repos: repos.map((repo) => {
      const repoRef = `${repo.owner}/${repo.name}`;
      return {
        provider: repo.provider,
        repoRef,
        defaultBranch: repo.defaultBranch,
        indexed: indexedRefs.includes(repoRef),
      };
    }),
  };
}

/**
 * THE PLANNING ENVELOPE'S `context.code` — *which repositories does THIS project
 * work on?* (MOTIR-4653 · MOTIR-2029).
 *
 * ⚠️ IT IS `resolveProjectCodeContext`, AND THIS CARD DID NOT NAME IT. MOTIR-4653
 * re-pointed the old `resolveCodeContext` from the workspace's grant to the
 * project's set
 * and left the name; `main` reached the same place from the other direction, by
 * ADDING this function beside the workspace reader. Merging them under ONE name
 * is the whole of the resolution — two functions answering *which repositories?*
 * with different filters is precisely the drift the story exists to remove — and
 * this is the name that says which scope it answers in, beside
 * `resolveWorkspaceConnectedRepos`.
 *
 * ⚠️ AN UNESTABLISHED ROW CONTRIBUTES NOTHING. A `project_repository` row is an
 * INTENT until something establishes it (`isEstablishedState`, ADR §0.1), and an
 * unrealized one has no host, no default branch and no graph — so there is
 * nothing for a planner to read and nothing honest to put on the wire. The state
 * test is the stricter of the two filters this merge had to choose between, and
 * it is the one `main` ships.
 *
 * ⚠️ AN EMPTY SET RESOLVES TO `undefined`, NOT TO AN EMPTY `repos` ARRAY. The
 * caller omits `context.code` entirely, so a project with no configured
 * repositories produces the SAME envelope as one whose workspace never connected
 * anything. That equivalence is the shipped contract this function has always
 * had, and it is what keeps a start-fresh project's job byte-identical.
 */
export async function resolveProjectCodeContext(ctx: {
  userId: string;
  workspaceId: string;
  projectId: string;
}): Promise<JobCodeContext | undefined> {
  const { repos, indexedRefs } = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: ctx.projectId },
    async (tx) => {
      const linked = await projectRepoRepository.listByProject(ctx.projectId, ctx.workspaceId, tx);
      const repos = linked.flatMap((row) => {
        const repo = row.githubRepo;
        if (!repo || !isEstablishedState(row.state)) return [];
        return [
          {
            provider: repo.provider,
            repoRef: `${repo.owner}/${repo.name}`,
            defaultBranch: repo.defaultBranch,
          },
        ];
      });
      // ⚠️ ONE LEDGER READ FOR THE WHOLE SET, and only when there IS a set — the
      // same read `resolveWorkspaceConnectedRepos` performs, so the envelope and
      // the reading state can never tell a user two different things about the
      // same repository. It stays WORKSPACE-keyed because the ledger is: the
      // index job writes one row per repo per workspace, and this story moves
      // which repositories are ASKED about, never how their indexed-ness is
      // recorded.
      const indexedRefs = repos.length
        ? await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(ctx.workspaceId, tx)
        : [];
      return { repos, indexedRefs };
    },
  );
  if (repos.length === 0) return undefined;
  return {
    repos: repos.map((repo) => ({
      ...repo,
      indexed: indexedRefs.includes(repo.repoRef),
    })),
  };
}

// ── The PLANNING-SESSION producer (Story MOTIR-1754 · MOTIR-4604) ────────────
//
// `resolveProjectCodeContext` above answers "which repos are connected?". A planning
// session needs more: **how current is each graph, why it is behind, and whether
// anything is actually doing something about it.**
//
// ⚠️ THE SESSION MUST NOT SAY "FETCHING THE LATEST" WHEN NOTHING IS FETCHING.
// A graph is rarely stale by accident — with push-driven refresh healthy the drift
// is minutes, so badly stale means something stopped it. That is why the envelope
// carries a REASON and an IN-FLIGHT FLAG as two separate facts: the reason
// EXPLAINS, the flag DECIDES WHICH EXITS EXIST. Collapsing them into one string
// would force the gate (MOTIR-4601) to parse prose to decide whether it may offer
// "come back later" — and a session that announces a fetch which is not happening
// is a new instance of exactly the dishonesty this story exists to remove, wearing
// the fix's clothes.

/** Why a repo's graph is not current. A TOTAL union — see the mapping below. */
// ⚠️ THE VOCABULARY MOVED TO `lib/codeGraph/refreshReason.ts` (MOTIR-2105) and is
// RE-EXPORTED here so every existing import site is unchanged. It is a fact
// about a code graph, and it now sits beside the other two derivations of the
// same subject — the state (`indexState.ts`) and the drift (`driftCount.ts`) —
// where the DTO a UI reads can import it without reaching into `lib/ai/`.
export type { CodeRefreshReason } from '@/lib/codeGraph/refreshReason';

/** One connected repo as it rides the job envelope, with its freshness. */
export interface JobCodeRepoState extends JobCodeRepo {
  /**
   * The repository's index state, from the ONE derivation
   * (`lib/codeGraph/indexState.ts`).
   *
   * ⚠️ IT IS NO LONGER OPTIONAL, and the reason it WAS is worth keeping: this
   * field used to be absent when freshness "could not be read", because it came
   * from motir-ai across the 7.1 boundary and an outage there must not make every
   * repository announce something false. MOTIR-4724 moved every fact into
   * motir-core's own columns, so there is no read left that can fail to answer —
   * the absence had a cause, and the cause is gone.
   */
  indexState: CodeGraphIndexState;
  /** Absent when the graph is CURRENT — there is nothing to explain. */
  reason?: CodeRefreshReason;
  /**
   * Is something actually running? The gate may offer "come back later" if and
   * only if this is true.
   *
   * ⚠️ A DEBOUNCED NO-OP STILL COUNTS AS IN FLIGHT. When the shipped debounce
   * suppresses this session's enqueue because a refresh is already pending,
   * something IS running and the wait is honest. Only "nothing will happen"
   * makes this false. Backwards, it silences the come-back exit exactly when it
   * is most useful.
   */
  refreshInFlight: boolean;
  /** When the graph was last built — rendered, never used to decide staleness. */
  indexedAt: Date | null;
  /** Drift in COMMITS. Always null until its producer ships (MOTIR-4644). */
  commitsBehind: number | null;
  /** The graph's commit and the default branch's head (MOTIR-10094); `null` when unknown. */
  indexedSha: string | null;
  defaultHead: string | null;
}

export interface JobPlanningCodeContext {
  repos: JobCodeRepoState[];
}

/**
 * The reason + in-flight flag for one repo — PURE, so every arm is drivable.
 *
 * ⚠️ TWO ARMS SHIP UNREACHABLE, DELIBERATELY, and the pattern is MOTIR-4590's:
 * write the mapping TOTAL with the arm present and its meaning fixed, so the day
 * its producer lands it becomes reachable and nothing here is rewritten.
 *
 *  - `paused` waits on MOTIR-4593, which records the pause reasons.
 *  - `refresh_failing` waits on a per-repo failure signal. The job ledger cannot
 *    supply one: a refresh run writes `output.repoRef` only on SUCCESS, so a
 *    FAILED row cannot be attributed to a repository at all. Deriving it from the
 *    workspace-aggregate would tell every repo that refreshes are failing because
 *    one of them is — which is worse than saying nothing.
 *
 * Neither is a gap left by accident, and neither may be faked from a signal that
 * does not mean it.
 */
export function resolveRefreshDisposition(input: {
  indexState: CodeGraphIndexState;
  canIndex: boolean;
  paused?: boolean;
  refreshFailing?: boolean;
}): { reason?: CodeRefreshReason; refreshInFlight: boolean; enqueue: boolean } {
  if (input.indexState === 'indexed') return { refreshInFlight: false, enqueue: false };
  // A host that cannot be indexed at all outranks every other explanation: there
  // is nothing to enqueue and no wait to offer, whatever else is true.
  if (!input.canIndex)
    return { reason: 'provider_unsupported', refreshInFlight: false, enqueue: false };
  if (input.paused) return { reason: 'paused', refreshInFlight: false, enqueue: false };
  if (input.refreshFailing)
    return { reason: 'refresh_failing', refreshInFlight: false, enqueue: false };
  // Already running — the flag is true and there is nothing to enqueue.
  if (input.indexState === 'indexing')
    return { reason: 'refresh_pending', refreshInFlight: true, enqueue: false };
  // Never indexed is a FIRST index, which the connect path owns. A refresh of a
  // graph that does not exist is not a thing to enqueue here.
  if (input.indexState === 'never')
    return { reason: 'never_indexed', refreshInFlight: false, enqueue: false };
  // Stale, indexable, nothing stopping it — this session enqueues.
  return { reason: 'refresh_enqueued', refreshInFlight: true, enqueue: true };
}

/**
 * `context.code` for a PLANNING session: the connected set, each repo's freshness
 * verdict, why it is behind, and whether a refresh is running — enqueuing one
 * where a refresh can actually run.
 *
 * ⚠️ IT NEVER BLOCKS. The enqueue is fire-and-forget through the SHIPPED
 * `enqueueCodeGraphRefresh`, and the session never awaits the result: whether a
 * refresh can land mid-conversation is MOTIR-4591's question, and that it must
 * not be waited on is settled here.
 *
 * ⚠️ AND IT DOES NOT SIT OUT THE 2-MINUTE DEBOUNCE (MOTIR-5360). This used to say
 * the debounce applied, and MOTIR-4591 measured what that cost: 122 s of the
 * ≈ 211 s it took motir-core's graph to become current. The debounce exists to
 * coalesce bursts of PUSHES, and a session start is one event with a person
 * waiting. So it enqueues with `trigger: 'session_start'`, which makes the run due
 * now while keeping the same event and the same debounce key. Five sessions in
 * ten minutes still produce one queued run at a time: each coalesces into the
 * pending one, and a run already executing holds the (repo × project) admission
 * slot. No second trigger with its own semantics.
 *
 * Returns `undefined` — exactly as `resolveProjectCodeContext` does — when the workspace
 * has no connected repo, so the caller OMITS `context.code` and a code-less
 * envelope stays byte-identical.
 */
export async function resolvePlanningCodeContext(ctx: {
  userId: string;
  workspaceId: string;
  projectId: string;
}): Promise<JobPlanningCodeContext | undefined> {
  const base = await resolveProjectCodeContext(ctx);
  if (!base) return undefined;

  const state = await resolveCodeContextState(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const byRef = new Map(state.repos.map((r) => [r.repoRef, r]));

  // ⚠️ THE "FRESHNESS UNAVAILABLE" BRANCH IS GONE. It returned an envelope with no
  // verdicts and one honest flag, because freshness came from motir-ai and an
  // outage there must not make every repository announce something false.
  // MOTIR-4724 made every fact a motir-core column, so the read cannot fail to
  // answer — the branch is not unreachable, it is inexpressible, and a branch
  // nothing can enter is worse than no branch at all.

  const repos: JobCodeRepoState[] = [];
  for (const repo of base.repos) {
    const joined = byRef.get(repo.repoRef);
    // ⚠️ A REPOSITORY THE PROJECT'S SET DOES NOT NAME, which is a real hole and
    // not a theoretical one: the base set above is the WORKSPACE's installation
    // grant, the join is the PROJECT's configured set, and the second is a subset
    // of the first. The fallback is `never`, NOT `indexed`.
    //
    // `indexed` looks like the conservative choice — absence of evidence is not
    // evidence of drift — and it is the wrong one, for the reason the DTO's own
    // header gives: `indexed` is a claim that the graph MATCHES the code, made at
    // the exact moment somebody is deciding whether to trust a plan built from it.
    // `never` claims only that we know of no graph, which is precisely what a
    // missing join row establishes. It also disposes correctly — `never_indexed`,
    // nothing in flight, nothing enqueued — where `indexed` would silently drop
    // the repository out of every explanation the gate can offer.
    const indexState = joined?.indexState ?? 'never';
    let canIndex: boolean;
    try {
      canIndex = providerSupportsRepoTarballUrl(getGitProvider(repo.provider as GitProviderId));
    } catch {
      // An unregistered provider cannot be indexed, and saying so is better than
      // throwing on the submit path.
      canIndex = false;
    }
    // ⚠️ `refreshFailing` FINALLY HAS A PRODUCER (MOTIR-2105). The disposition
    // has been able to SAY a refresh is failing since MOTIR-4604 and nothing
    // ever told it — so the one explanation a session most needed, *the graph is
    // behind and nothing is coming*, was structurally unreachable while the
    // field sat in the signature looking covered.
    const disposition = resolveRefreshDisposition({
      indexState,
      canIndex,
      refreshFailing: joined?.refreshFailing ?? false,
    });

    if (disposition.enqueue) {
      // Best-effort, exactly like the webhook's own enqueue: a queue failure must
      // never fail a planning submit.
      try {
        const installationId = await installationIdForWorkspace(ctx);
        if (installationId) {
          await enqueueCodeGraphRefresh(
            {
              installationId,
              workspaceId: ctx.workspaceId,
              repoOwner: repo.repoRef.split('/')[0] ?? '',
              repoName: repo.repoRef.split('/').slice(1).join('/'),
              defaultBranch: repo.defaultBranch,
            },
            // A person is waiting, so the refresh does not sit out the PUSH
            // debounce (MOTIR-5360). It still coalesces with a queued one.
            { trigger: 'session_start' },
          );
        }
      } catch (err) {
        console.error('[codeContext] refresh not enqueued at session start; planning proceeds', {
          repoRef: repo.repoRef,
          err,
        });
      }
    }

    repos.push({
      ...repo,
      indexState,
      ...(disposition.reason ? { reason: disposition.reason } : {}),
      refreshInFlight: disposition.refreshInFlight,
      indexedAt: joined?.indexedAt ?? null,
      commitsBehind: joined?.commitsBehind ?? null,
      indexedSha: joined?.indexedSha ?? null,
      defaultHead: joined?.defaultHead ?? null,
    });
  }

  return { repos };
}

/** The workspace's installation id, or null — the enqueue's required key. */
async function installationIdForWorkspace(ctx: {
  userId: string;
  workspaceId: string;
}): Promise<string | null> {
  const installation = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => githubInstallationRepository.findByWorkspaceId(ctx.workspaceId, tx),
  );
  return installation?.installationId ?? null;
}

/**
 * The thin grant-list context, with each repository's FRESHNESS joined on
 * (Story MOTIR-1754 · MOTIR-4857).
 *
 * ⚠️ WHY A COMPOSER RATHER THAN A WIDER `resolveProjectCodeContext`. That resolver is
 * WORKSPACE-scoped and has four other callers; freshness is a PROJECT-scoped
 * fact (`resolveCodeContextState` reads the project's configured set). Widening
 * the workspace read to take a project would either give its other callers a
 * parameter they have no answer for, or invent one. So the join happens here, at
 * the one call site that has both.
 *
 * ⚠️ IT COMPUTES NOTHING. Every field comes from `resolveCodeContextState`,
 * which is itself an assembler over `lib/codeGraph/indexState.ts` and
 * `lib/codeGraph/driftCount.ts` — the ONE derivation of each. A second
 * comparison written here would be a second answer on a different surface.
 */
export async function withCodeFreshness(
  code: JobCodeContext | undefined,
  projectId: string,
  ctx: { userId: string; workspaceId: string },
): Promise<JobCodeContext | undefined> {
  if (!code || code.repos.length === 0) return code;
  const state = await resolveCodeContextState(projectId, ctx);
  const byRef = new Map(state.repos.map((r) => [r.repoRef, r]));
  return {
    repos: code.repos.map((repo) => {
      const joined = byRef.get(repo.repoRef);
      // ⚠️ NO JOIN ⇒ NO FIELDS. Spreading `undefined` in would put the keys on
      // the wire carrying nothing, which reads to a consumer as an answer.
      if (!joined) return repo;
      return {
        ...repo,
        indexState: joined.indexState,
        commitsBehind: joined.commitsBehind,
        indexedSha: joined.indexedSha,
        defaultHead: joined.defaultHead,
      };
    }),
  };
}
