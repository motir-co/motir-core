import { existsSync } from 'node:fs';
import { resolveRepo, type LinkConfig, type RepoResolutionSource } from './config/linkConfig.js';
import {
  isOrderingAdvisory,
  isReferenceAdvisory,
  isRepoStraddleAdvisory,
  isSubsumptionAdvisory,
} from './client.js';
import type { DispatchPrompt, DispatchWorkflowMode, WorkItemClaim } from './client.js';
import { runRepoClones, type RepoClonePlanEntry } from './repoClone.js';
import type { CommandRunner } from './git.js';
import type { DeliveredRepository, UndeliveredRepository } from './runDelivery.js';

// The PURE half of single dispatch (Story 7.9 · Subtask 7.9.3 · MOTIR-881):
// where an item's agent runs, what the human is told about it, and how a
// bootstrap dispatch is verified afterwards. No MCP, no spawn, no stdout — the
// I/O half lives in commands/dispatch.ts and agentRun.ts, so the whole routing
// matrix is unit-testable without a server, an agent binary, or a real
// filesystem (`exists` is injected).
//
// REPO ROUTING is the load-bearing rule here. The dispatch payload names the
// item's repo (`targetRepo`, MOTIR-1804 — a bare name like `motir-core`, or
// `null` when Motir genuinely cannot say). The CLI maps that name to a checkout
// through the link's override map / the `<root>/<repoName>` convention
// (7.9.1's `resolveRepo`) and runs the agent THERE. Three outcomes, and only
// three — the CLI never picks a DIFFERENT existing checkout as a fallback,
// because dispatching an item into the wrong repo is worse in every way than
// admitting the gap.

/**
 * WHY the agent's cwd is what it is — the four routing outcomes:
 *
 * - `repo_checkout` — the item names a repo AND that checkout exists: run
 *   inside it. This is what makes dispatching a `motir-ai` item while standing
 *   in `motir-core` work.
 * - `clonable_checkout` — the item names a repo whose checkout is MISSING, and
 *   the payload carries a CLONE URL for it: materialize it first, then run
 *   inside it (MOTIR-3588). `cwd` is where the checkout WILL be, and the caller
 *   must not launch an agent until {@link materializeDispatchCheckouts} has
 *   succeeded for it.
 * - `bootstrap_root` — the item names a repo whose checkout is missing AND the
 *   payload carries no clone URL: the genuine empty-folder bootstrap, where a
 *   scaffold item's own work is to CREATE the repository. Run at the workspace
 *   root, verified after a successful run. PRESERVED unchanged.
 * - `unpinned_root` — the payload carries no repo (`targetRepo: null`): run at
 *   the workspace root. `null` is a real answer ("Motir does not know"), never
 *   a licence to guess a checkout.
 *
 * ⚠️ THE DISCRIMINATOR BETWEEN THE MIDDLE TWO IS THE PRESENCE OF A CLONE URL,
 * NOT THE ABSENCE OF A DIRECTORY. Both used to be `bootstrap_root`, on the
 * recorded reasoning that *"the prompt creates it"* — and the prompt does not:
 * both GIT WORKFLOW variants open with `git fetch origin && git worktree add …`,
 * which cannot run in a directory that is not a git repository. So a repository
 * that EXISTS on the host and simply is not cloned here was being handed a
 * prompt whose first command fails, and the failure was reported by
 * `checkBootstrapCheckout` only AFTER the agent had spent its tokens.
 */
export type DispatchCwdReason =
  | 'repo_checkout'
  | 'clonable_checkout'
  | 'bootstrap_root'
  | 'unpinned_root';

export interface DispatchTarget {
  /** The resolved repo NAME from the dispatch payload, or null when unpinned. */
  targetRepo: string | null;
  /** Absolute path the agent process runs in. */
  cwd: string;
  reason: DispatchCwdReason;
  /** Where the pinned repo's checkout resolves to — null when unpinned. Set
   *  even in `bootstrap_root`, where it is the path we expect to APPEAR. */
  repoPath: string | null;
  /** How `repoPath` was resolved (`override` from `.motir.json` / the
   *  `<root>/<repoName>` `convention`), or null when unpinned. */
  repoSource: RepoResolutionSource | null;
  /** Where this repository is cloned from — set only on `clonable_checkout`,
   *  which is the outcome that has one by definition. */
  cloneUrl: string | null;
  /** True only for `bootstrap_root`: the run must be followed by a checkout
   *  existence check (see {@link checkBootstrapCheckout}). */
  verifyCheckoutAfterRun: boolean;
}

export interface ResolveDispatchTargetOptions {
  /** Injectable path-existence predicate (the tests' seam). */
  exists?: (path: string) => boolean;
  /**
   * WHERE this repository is cloned from, when the payload says.
   *
   * Absent or null reads as "there is nothing to clone from", which is the
   * preserved `bootstrap_root` path — the same answer for a card whose provider
   * yields no URL and for a server too old to send one.
   */
  cloneUrl?: string | null;
}

/**
 * Decide WHERE to run an item, from the link root + the payload's `targetRepo`.
 * See {@link DispatchCwdReason} for the three outcomes. Deliberately total: an
 * unresolvable repo falls back to the ROOT, never to another checkout.
 */
export function resolveDispatchTarget(
  rootDir: string,
  config: LinkConfig,
  targetRepo: string | null,
  opts: ResolveDispatchTargetOptions = {},
): DispatchTarget {
  const exists = opts.exists ?? existsSync;
  if (!targetRepo) {
    return {
      targetRepo: null,
      cwd: rootDir,
      reason: 'unpinned_root',
      repoPath: null,
      repoSource: null,
      cloneUrl: null,
      verifyCheckoutAfterRun: false,
    };
  }
  // `resolveRepo` computes its own `exists` off the real fs; re-test with the
  // injected predicate so the routing decision is the one under test.
  const resolved = resolveRepo(rootDir, config, targetRepo);
  const present = exists(resolved.path);
  const cloneUrl = opts.cloneUrl ?? null;

  if (present) {
    return {
      targetRepo,
      cwd: resolved.path,
      reason: 'repo_checkout',
      repoPath: resolved.path,
      repoSource: resolved.source,
      cloneUrl: null,
      verifyCheckoutAfterRun: false,
    };
  }

  if (cloneUrl !== null) {
    // The repository EXISTS on the host and is simply not cloned here. `cwd` is
    // where it will be — the caller materializes it before spawning anything.
    return {
      targetRepo,
      cwd: resolved.path,
      reason: 'clonable_checkout',
      repoPath: resolved.path,
      repoSource: resolved.source,
      cloneUrl,
      verifyCheckoutAfterRun: false,
    };
  }

  return {
    targetRepo,
    cwd: rootDir,
    reason: 'bootstrap_root',
    repoPath: resolved.path,
    repoSource: resolved.source,
    cloneUrl: null,
    verifyCheckoutAfterRun: true,
  };
}

/**
 * Decide where to run EVERY repository of an item's set (Story MOTIR-2731 ·
 * MOTIR-3133) — one {@link DispatchTarget} per repository, in the payload's
 * order, primary first.
 *
 * Each element is resolved by {@link resolveDispatchTarget}, unchanged, so the
 * routing matrix is applied per repository rather than re-derived for a set:
 * the override map, the `<root>/<name>` convention and the three outcomes all
 * behave exactly as they do for a single-repository card. Only element 0's `cwd`
 * is ever used to launch the agent — one dispatch, one agent process; the others
 * are places it works, not places it is launched in.
 *
 * An EMPTY set returns `[]`. The caller falls back to the scalar in that case,
 * which is also what happens against a server too old to send `targetRepos`.
 */
export function resolveDispatchTargets(
  rootDir: string,
  config: LinkConfig,
  repos: readonly (string | { name: string; cloneUrl: string | null })[],
  opts: ResolveDispatchTargetOptions = {},
): DispatchTarget[] {
  return repos.map((repo) =>
    typeof repo === 'string'
      ? resolveDispatchTarget(rootDir, config, repo, opts)
      : resolveDispatchTarget(rootDir, config, repo.name, {
          ...opts,
          // PER ELEMENT (MOTIR-3588): a card shipping in two repositories
          // materializes each one from ITS own URL, so a set with one missing
          // checkout is not routed by whichever element happened to be first.
          cloneUrl: repo.cloneUrl,
        }),
  );
}

/** What a pre-dispatch materialization DID, or failed to do. */
export interface DispatchMaterialization {
  /** Every repository that was cloned, in the order it was attempted. */
  cloned: string[];
  /** The repositories that could not be materialized, with the reason. Non-empty
   *  means the dispatch MUST NOT launch an agent. */
  failures: { repo: string; detail: string; gitMessage: string | null }[];
}

/**
 * MATERIALIZE every `clonable_checkout` in a resolved target set, BEFORE any
 * agent is spawned (MOTIR-3588).
 *
 * ⚠️ IT CALLS THE LINK CARD'S PRIMITIVE. `runRepoClones` is the one
 * implementation of "clone a repository the user does not have", and it is where
 * the ADR's rules live — full clone, never write into an existing path, one
 * outcome per repository, git's own message kept. A second `git clone` site here
 * is exactly how those rules get honoured in one place and not the other, and
 * `packages/cli/test/architecture.test.ts` fails on one.
 *
 * ⚠️ A FAILURE STOPS THE DISPATCH. This is the one place the never-abort posture
 * of the link command inverts, and deliberately: `motir link` is materializing
 * a whole set for a person to look at, while this is materializing the ONE
 * checkout an agent is about to be launched into. Launching it anyway would hand
 * the agent the prompt that cannot run — the exact failure this card removes.
 */
export function materializeDispatchCheckouts(
  rootDir: string,
  targets: readonly DispatchTarget[],
  opts: { run?: CommandRunner } = {},
): DispatchMaterialization {
  const clonable = targets.filter(
    (
      t,
    ): t is DispatchTarget & {
      repoPath: string;
      repoSource: RepoResolutionSource;
      cloneUrl: string;
      targetRepo: string;
    } =>
      t.reason === 'clonable_checkout' &&
      t.repoPath !== null &&
      t.repoSource !== null &&
      t.cloneUrl !== null,
  );
  if (clonable.length === 0) return { cloned: [], failures: [] };

  const plan: RepoClonePlanEntry[] = clonable.map((target) => ({
    label: target.targetRepo,
    // A dispatch payload carries no establish state, and it does not need one:
    // it only ever names repositories a card actually ships in, which the server
    // resolved from ESTABLISHED rows already.
    state: 'connected',
    kind: 'clone' as const,
    path: target.repoPath,
    source: target.repoSource,
    cloneUrl: target.cloneUrl,
    archived: false,
  }));

  const outcomes = runRepoClones(rootDir, plan, opts.run ? { run: opts.run } : {});
  return {
    cloned: outcomes.filter((o) => o.status === 'cloned').map((o) => o.label),
    failures: outcomes
      .filter((o) => o.status === 'failed')
      .map((o) => ({ repo: o.label, detail: o.detail, gitMessage: o.gitMessage })),
  };
}

/** The lines a caller prints for a materialization — cloned first, then any
 *  refusal with git's own sentence beneath it. */
export function renderMaterialization(result: DispatchMaterialization): string[] {
  const lines: string[] = [];
  for (const repo of result.cloned) lines.push(`Cloned:     ${repo}`);
  for (const failure of result.failures) {
    lines.push(`Blocked:    ${failure.repo} — ${failure.detail}`);
    if (failure.gitMessage) lines.push(`            git said: ${failure.gitMessage}`);
  }
  if (result.failures.length > 0) {
    lines.push('            No agent was started: the prompt it would be handed opens with');
    lines.push('            `git worktree add`, which cannot run without the checkout.');
  }
  return lines;
}

export interface SuspectDispatch {
  repoName: string;
  expectedPath: string;
  message: string;
  hint: string;
}

/**
 * The bootstrap POST-CONDITION: after an agent exits 0 on a `bootstrap_root`
 * dispatch, the checkout it was supposed to create must now exist. When it does
 * not, the run is SUSPECT — most likely the repo lives off-convention, which
 * `motir link add` fixes. Returns null in every other case (nothing to verify,
 * or the checkout appeared as expected).
 */
export function checkBootstrapCheckout(
  target: DispatchTarget,
  opts: ResolveDispatchTargetOptions = {},
): SuspectDispatch | null {
  const exists = opts.exists ?? existsSync;
  if (!target.verifyCheckoutAfterRun || !target.targetRepo || !target.repoPath) return null;
  if (exists(target.repoPath)) return null;
  return {
    repoName: target.targetRepo,
    expectedPath: target.repoPath,
    message:
      `Suspect dispatch: the agent exited 0 but "${target.targetRepo}" still has no checkout ` +
      `at ${target.repoPath}.`,
    hint: `If this repo lives elsewhere, run \`motir link add ${target.targetRepo} <path>\`.`,
  };
}

/** How the agent command was resolved, so the summary can say so. */
export type AgentSource = 'flag' | 'env' | 'config' | 'hosted' | 'agent';

const AGENT_SOURCE_LABEL: Record<AgentSource, string> = {
  flag: '--agent',
  env: 'MOTIR_AGENT',
  config: 'config agentCommand',
  // The hosted run's built-in launcher (MOTIR-6559): OpenCode on MOTIR_MODEL.
  hosted: 'the hosted run (MOTIR_MODEL)',
  // A run in the developer's own agent (MOTIR-7024): the image's profile.
  agent: "the agent's own coding agent (MOTIR_SANDBOX_AGENT)",
};

export function agentSourceLabel(source: AgentSource): string {
  return AGENT_SOURCE_LABEL[source];
}

/** Human label for a routing outcome, used in the dispatch summary. */
export function cwdReasonLabel(target: DispatchTarget): string {
  switch (target.reason) {
    case 'repo_checkout':
      return `${target.targetRepo ?? ''} checkout (${target.repoSource})`;
    case 'clonable_checkout':
      return `${target.targetRepo ?? ''} checkout (${target.repoSource}) — cloned first`;
    case 'bootstrap_root':
      // ⚠️ It no longer says "the prompt creates it", because the prompt does
      // not: both GIT WORKFLOW variants open with `git worktree add`, which
      // cannot run outside a git repository. This label now names the ONE case
      // that legitimately reaches it — a repository that does not exist anywhere
      // yet, whose creation is the dispatched card's own work.
      return `workspace root — "${target.targetRepo ?? ''}" does not exist yet; this work item creates it`;
    case 'unpinned_root':
      return 'workspace root — the item pins no repo';
  }
}

/** A one-line description of the git workflow the SERVER chose for this item. */
export function workflowLabel(mode: DispatchWorkflowMode, sessionBranch: string | null): string {
  return mode === 'session_lineage'
    ? `session lineage on ${sessionBranch ?? '(unnamed branch)'}`
    : 'one pull request of its own';
}

/**
 * The PROSE-vs-GRAPH warning (MOTIR-2079), or `null` when there is nothing to
 * say. Rendered from `dispatch_prompt`'s `advisories`: work items this card's
 * ACCEPTANCE CRITERIA name while carrying no `blocked_by` edge to them.
 *
 * ⚠️ A WARNING, NOT A REFUSAL — and the difference is the whole point. A missing
 * dependency EDGE is a fact, so `notReadyError` refuses and offers `--force`. A
 * prose reference is a HINT: a boundary-contract card legitimately names both
 * halves of a two-PR split, an acceptance criterion legitimately names a card
 * for contrast, and a sibling may be merged before this item is started.
 * Refusing those would teach authors to write vaguer acceptance criteria, which
 * is worse than the miss it would catch. So the dispatch proceeds, the exit code
 * is untouched, no `--force` is required — and the human sees the reference.
 *
 * Diagnostics, so it goes to STDERR with the summary: `motir next --print |
 * pbcopy` must still pipe the prompt and nothing else.
 */
export function renderDispatchAdvisories(dispatch: DispatchPrompt): string | null {
  const advisories = dispatch.advisories ?? [];
  if (advisories.length === 0) return null;
  // Matched POSITIVELY, family and severity both: a family or severity a newer
  // server emits and this build does not know matches NO filter and prints
  // nothing, rather than printing another member's fields as `undefined`. The
  // reference filter used to be the `kind !== 'shape'` catch-all, which had
  // exactly that defect the moment a third family arrived (MOTIR-2903).
  const references = advisories.filter(isReferenceAdvisory);
  const shapes = advisories.filter(isOrderingAdvisory);
  const straddles = advisories.filter(isRepoStraddleAdvisory);
  const subsumed = advisories.filter(isSubsumptionAdvisory);
  const lines: string[] = [];

  if (references.length > 0) {
    lines.push(
      `Advisory:   ${dispatch.key}'s acceptance criteria name work items it has no blocked_by edge to.`,
      ...references.map((a) => `            - ${a.referenced} (${a.referencedStatus})`),
      '            This is NOT a blocker — the dispatch proceeds. Before branching,',
      '            check each one is already on origin/main; if it lives only on an open',
      '            PR, add the blocked_by edge and stop instead of rebuilding its half.',
    );
  }
  // The ORDERING advisory (MOTIR-2175). Same disposition, different remedy: the
  // reference block says "go check something"; this one says "part of this card
  // is not yours to finish", which the operator needs BEFORE the agent starts.
  for (const s of shapes) {
    lines.push(
      `Advisory:   ${dispatch.key}'s acceptance criterion ${s.criterionIndex} says "${s.phrase}" —`,
      "            state that exists only after this work item's own PR has merged.",
      '            This is NOT a blocker — the dispatch proceeds. Your boundary ends at',
      '            PR opened, so that criterion and everything below it belongs to a',
      '            follow-on work item. Build what is above the line and report the split.',
    );
  }
  // The REPO-STRADDLE advisory (MOTIR-2177). The operator is the one who knows
  // whether the other repo's half already merged, or whether this is a
  // boundary-contract card — the two shapes that make this a false positive —
  // so the path is named and the judgement is left with them.
  for (const s of straddles) {
    lines.push(
      `Advisory:   ${dispatch.key}'s acceptance criterion ${s.criterionIndex} names ${s.path},`,
      `            which lives in ${s.repo}${
        s.reason === 'contradiction'
          ? " — not this work item's pinned repo."
          : ', and this item pins no repo while its criteria name more than one.'
      }`,
      '            This is NOT a blocker — the dispatch proceeds. One subtask, one repo,',
      '            one PR: check the other repo before branching. If that half is already',
      '            merged, or this is a boundary-contract item, proceed; otherwise surface',
      "            the split rather than dropping the other repo's criteria.",
    );
  }
  // The SUBSUMPTION advisory (MOTIR-2903). The operator is the one who can read
  // a diff in ten seconds and decide, and the alternative to their reading it is
  // an agent spending a session rebuilding something already on `main`.
  for (const s of subsumed) {
    lines.push(
      `Advisory:   ${dispatch.key}'s body names ${s.path}, which ${s.pullRequest} already`,
      `            changed (merged ${s.mergedAt}).`,
      '            This is NOT a blocker — the dispatch proceeds. But this work item may already',
      "            be built: read that pull request against the item's acceptance criteria.",
      '            If it delivers them, close the item with the merge as the evidence instead',
      '            of rebuilding it. If the two merely share a file, proceed.',
    );
  }
  // Nothing MATCHED, not merely nothing sent: a payload carrying only advisories
  // this build cannot render is the same "nothing to say" as an empty array, and
  // must produce no output rather than a blank line (MOTIR-2177).
  return lines.length === 0 ? null : lines.join('\n');
}

export interface DispatchSummaryInput {
  key: string;
  title: string | null;
  dispatch: DispatchPrompt;
  target: DispatchTarget;
  /**
   * Every repository of the item's set, resolved (MOTIR-3133) — element 0 is
   * `target`. Absent, empty or of length ONE renders exactly today's two lines:
   * this block exists only where a card actually ships in more than one place.
   */
  targets?: DispatchTarget[];
  /** The agent about to run, or null in `--print` mode. */
  agent: { command: string; source: AgentSource } | null;
}

/**
 * The six per-repository delivery states, in the words a PERSON needs
 * (MOTIR-3136 · `lib/workItems/repoDelivery.ts`).
 *
 * ⚠️ `unestablished` and `excluded` are NOT shades of `awaiting`, and the
 * difference is the reader's next ACTION rather than a nuance. `awaiting` says a
 * pull request has not been opened and points at the host; `unestablished` says
 * there is no repository to open one against and points at the project's
 * establish step; `excluded` says nothing is expected there at all, and it is
 * the one state that does not hold the card. Collapsing them is what produced
 * the false "No pull request yet" row one level down.
 *
 * An UNKNOWN state — one a newer server added — renders verbatim rather than
 * being mapped onto a neighbour, for the same reason the advisory renderer
 * prints nothing for a family it does not know: a build that guesses is worse
 * than one that admits.
 */
function deliveryLabel(state: string | null): string | null {
  switch (state) {
    case null:
      return null;
    case 'delivered':
      return 'delivered — a pull request has merged onto its default branch';
    case 'awaiting':
      return 'awaiting — no merged pull request yet';
    case 'unknown':
      return 'unknown — a merge is recorded but not which branch it reached';
    case 'unestablished':
      return 'NOT ESTABLISHED — this repository does not exist yet, so there is nothing to open a pull request against';
    case 'excluded':
      return 'excluded — the project is deliberately code-less here; it does not hold this work item';
    case 'delivered_without_change_request':
      return 'delivered without a pull request — its cards finished without one (a tag, a release, a setting); it does not hold this work item';
    default:
      return state;
  }
}

/** The repositories of a card that carries more than one, or `[]`. */
function repoSet(dispatch: DispatchPrompt): NonNullable<DispatchPrompt['targetRepos']> {
  const repos = dispatch.targetRepos ?? [];
  return repos.length >= 2 ? repos : [];
}

/**
 * The RESUME line (MOTIR-3136) — printed only when at least one repository has
 * delivered and at least one has not.
 *
 * A partially delivered card is a legitimate resting state, not an error (ADR
 * §B4), and the whole cost of not saying so is that a resumed run reads exactly
 * like a fresh one: the operator has no way to tell that half the work is
 * already on `main` and the agent should not re-open it.
 */
export function renderResumeNotice(dispatch: DispatchPrompt): string | null {
  const repos = repoSet(dispatch);
  const done = (d: string | null) => d === 'delivered' || d === 'delivered_without_change_request';
  const delivered = repos.filter((r) => done(r.delivery)).map((r) => r.name);
  const remaining = repos.filter((r) => !done(r.delivery)).map((r) => r.name);
  if (delivered.length === 0 || remaining.length === 0) return null;
  return [
    `Resume:     ${dispatch.key} is PARTIALLY DELIVERED — this is not a fresh work item.`,
    `            already delivered: ${delivered.join(', ')}`,
    `            still outstanding: ${remaining.join(', ')}`,
    '            Do not re-open a pull request in a repository that has already merged.',
  ].join('\n');
}

/**
 * The REPOSITORIES block — one line per repository, in set order, with the
 * primary marked as the working directory.
 *
 * ⚠️ A MISSING CHECKOUT IS A WARNING HERE, NOT A REFUSAL, and it is the same
 * doctrine {@link renderDispatchAdvisories} sets out one function down: the
 * operator is the one who knows whether that repository's half is already
 * merged, or whether their checkout simply lives somewhere the convention does
 * not predict. Refusing would convert a resumable card into a blocked one over a
 * fact the tool is not the authority on. So the line names the repository, the
 * path that was expected and the `motir link add` fix, the dispatch proceeds,
 * and the exit code is untouched. (ADR `work-item-repository-set.md`
 * § *Amendment 2026-08-19* §B6(a).)
 */
export function renderRepositoriesBlock(
  targets: DispatchTarget[],
  delivery?: (string | null)[],
): string[] {
  if (targets.length <= 1) return [];
  const lines = [`Repos:      ${targets.length} — this item ships in every one of them:`];
  targets.forEach((t, i) => {
    const where = i === 0 ? 'the working directory' : 'a sibling checkout';
    lines.push(`            - ${t.targetRepo ?? '(unpinned)'}  (${where})`);
    lines.push(`                ${t.repoPath ?? t.cwd}  (${t.repoSource ?? 'root'})`);
    // MOTIR-3136 — what this repository has already shipped, beside where it is.
    const label = deliveryLabel(delivery?.[i] ?? null);
    if (label) lines.push(`                ${label}`);
    if (t.reason === 'bootstrap_root') {
      lines.push(
        `                ⚠ no checkout here yet. This is NOT a blocker — the dispatch`,
        `                  proceeds. If it lives elsewhere: motir link add ${t.targetRepo ?? ''} <path>`,
      );
    }
  });
  return lines;
}

/**
 * The status block that accompanies a dispatch. In `--print` mode this goes to
 * STDERR while the prompt goes to stdout, so `motir next --print | pbcopy`
 * pipes the prompt alone — and the copy-paste user still SEES which repo and
 * which resolved path the prompt expects to be run in.
 */
export function renderDispatchSummary(input: DispatchSummaryInput): string {
  const { key, title, dispatch, target, agent } = input;
  const lines = [
    `Dispatch:   ${key}${title ? ` — ${title}` : ''}`,
    `Repo:       ${dispatch.targetRepo ?? 'not pinned (Motir cannot say)'}`,
    `Path:       ${target.cwd}`,
    `            ${cwdReasonLabel(target)}`,
    // MOTIR-3133 — every OTHER repository the card ships in, and where each one
    // resolved to. Nothing is emitted for a one-repository or unpinned card, so
    // the two lines above are still the whole answer for every card that exists.
    ...renderRepositoriesBlock(
      input.targets ?? [],
      (dispatch.targetRepos ?? []).map((r) => r.delivery),
    ),
    `Workflow:   ${workflowLabel(dispatch.workflowMode, dispatch.sessionBranch)}`,
  ];
  lines.push(
    agent
      ? `Agent:      ${agent.command}  (${agentSourceLabel(agent.source)})`
      : 'Agent:      none — printing the prompt (copy it into your agent)',
  );
  return lines.join('\n');
}

/**
 * What the human should do after the agent exits 0. The two workflow modes end
 * differently: a per-item PR waits for the human's merge, then `motir done`; a
 * session-lineage item has JOINED a branch that ships with that session's PR,
 * so its close-out is the bulk `motir done --session`.
 */
export function renderAgentSuccess(key: string, dispatch: DispatchPrompt): string {
  const repos = repoSet(dispatch);
  if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
    if (repos.length > 0) {
      return [
        `${key}: agent finished — integrated on "${dispatch.sessionBranch}" in ${repos.length}`,
        `repositories: ${repos.map((r) => r.name).join(', ')}.`,
        'CI decides when each becomes reviewable: the item moves to In Review on its own',
        'when the checks go green.',
        `Next: review + merge the session PR in EACH of them, then`,
        `\`motir done --session ${dispatch.sessionBranch}\`.`,
        `${key} is not complete until every repository's pull request has merged.`,
      ].join('\n');
    }
    return [
      `${key}: agent finished — integrated on "${dispatch.sessionBranch}" (now Implemented).`,
      'CI decides when it becomes reviewable: the item moves to In Review on its own',
      'when the checks on that branch go green.',
      `Next: review + merge the session PR, then \`motir done --session ${dispatch.sessionBranch}\`.`,
    ].join('\n');
  }
  // ⚠️ THE MULTI-REPOSITORY FORM MUST NOT SAY THE CARD IS FINISHED. The single
  // line below is not merely incomplete for a card carrying two repositories —
  // it reads as reassurance, at the exact moment the operator could still notice
  // that half the work has no pull request. It also drops the singular follow-up
  // deliberately: `motir done <key>` on a card the completion gate is holding
  // would be an instruction that cannot succeed.
  if (repos.length > 0) {
    const lines = [
      `${key}: agent finished — a pull request is expected in EACH of its ${repos.length} repositories:`,
    ];
    for (const repo of repos) {
      const label = deliveryLabel(repo.delivery);
      lines.push(`  - ${repo.name}${label ? ` — ${label}` : ''}`);
    }
    const blocked = repos.filter((r) => r.delivery === 'unestablished');
    if (blocked.length > 0) {
      lines.push(
        '',
        `⚠ ${blocked.map((r) => r.name).join(', ')} cannot be delivered yet: the repository does`,
        '  not exist. Establish it on the project before this work item can complete.',
      );
    }
    lines.push(
      '',
      'CI decides when it becomes reviewable: the item moves to In Review on its own',
      'when the checks go green.',
      `Next: review + merge every one of them. ${key} completes only when EVERY`,
      "repository's pull request has merged — a single merge leaves it held.",
    );
    return lines.join('\n');
  }
  return [
    `${key}: agent finished — its pull request is open (now Implemented).`,
    'CI decides when it becomes reviewable: the item moves to In Review on its own',
    'when the checks on that pull request go green.',
    `Next: review + merge the PR, then \`motir done ${key}\`.`,
  ].join('\n');
}

/**
 * The agent exited 0 but NOTHING for this card reached the remote (MOTIR-3004).
 *
 * `implemented` is a claim that the code is pushed, so this run cannot make it —
 * and the honest failure is to say so and leave the card in progress rather than
 * to record a card whose work exists only in a worktree that is about to be
 * deleted. The item is excluded from the next pick for the same reason a failed
 * agent's is: re-picking it in the same session would just repeat the run.
 */
export function renderNothingPushed(key: string, dispatch: DispatchPrompt): string {
  const where =
    dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch
      ? `no commit naming ${key} is on origin/${dispatch.sessionBranch}`
      : `no branch naming ${key} is on the remote`;
  return [
    `${key}: agent exited 0, but ${where}.`,
    'The work item stays In Progress: Implemented means the code is PUSHED, and this run',
    'cannot claim that. Nothing was reverted — check the worktree for uncommitted or',
    'unpushed work.',
    `It is excluded from the next \`motir next\` in this session; re-run it with \`motir run ${key}\`.`,
  ].join('\n');
}

/** The part of a dispatch-leg verdict the delivery rule reads. */
interface DeliveryVerdict {
  remote?: 'pushed' | 'unknown';
  delivery?: {
    linked: readonly unknown[];
    unlinked: readonly Pick<UndeliveredRepository, 'pushed'>[];
  } | null;
}

/**
 * The unlinked repositories that keep a pushed card from Implemented (MOTIR-10877 ·
 * MOTIR-10888). With NOTHING linked, every one of them: the push check already saw the work
 * on the remote, and a card linked to nothing is closed by nothing. With at least one pull
 * request linked, only those whose work IS on their remote: a listed repository the run
 * pushed nothing to needed no change, while a pushed one with no linked pull request is half
 * the card's work that the first merge would close the card over — Motir completes a card on
 * its LINKED pull requests alone (`changeRequestStatusSync.ts`, MOTIR-10135).
 */
export function unlinkedDeliveries<T extends Pick<UndeliveredRepository, 'pushed'>>(delivery: {
  linked: readonly unknown[];
  unlinked: readonly T[];
}): T[] {
  return delivery.linked.length === 0
    ? [...delivery.unlinked]
    : delivery.unlinked.filter((u) => u.pushed);
}

/**
 * Whether a succeeded leg pushed work the run could not link to a pull request (MOTIR-10877),
 * in ANY repository of the card (MOTIR-10888) — the case the card must not be reported a clean
 * Implemented: nothing would close it on merge (or the first merge would close it over the
 * unlinked work), and the CI watch would not see that work. With nothing linked, only a push
 * the check SAW counts (an `unknown` remote is no evidence); with something linked, each
 * unlinked repository's own remote is the evidence. Only a leg the run delivered itself
 * counts (a session-lineage leg's pull request is the loop's).
 */
export function pushedButUnlinked<V extends DeliveryVerdict>(
  verdict: V,
): verdict is V & { delivery: NonNullable<V['delivery']> } {
  const delivery = verdict.delivery;
  if (!delivery) return false;
  if (delivery.linked.length === 0) return verdict.remote === 'pushed';
  return unlinkedDeliveries(delivery).length > 0;
}

/**
 * What the human reads when the run pushed work it could not link (MOTIR-10877). `linked`
 * names the pull requests that DID link, when some did (MOTIR-10888), so the reader knows
 * which branches are left to link by hand.
 */
export function renderNoLinkedPullRequest(
  key: string,
  unlinked: readonly Pick<UndeliveredRepository, 'repository' | 'branch' | 'reason'>[],
  linked: readonly Pick<DeliveredRepository, 'repository' | 'url'>[] = [],
): string {
  const branchLines = unlinked.map(
    (u) => `  ${u.repository ?? '(unpinned)'} · ${u.branch ?? '(no branch)'} — ${u.reason}`,
  );
  if (linked.length === 0) {
    return [
      `${key}: the work is pushed, but no pull request could be linked to ${key}.`,
      ...branchLines,
      'The work item stays In Progress: an Implemented card with no linked pull request is',
      'closed by nothing when the pull request merges. Open the pull request (or link the one',
      `that exists) and move ${key} to Implemented, or re-run it with \`motir run ${key}\`.`,
    ].join('\n');
  }
  return [
    `${key}: ${linked.length} pull request${linked.length === 1 ? ' is' : 's are'} linked, but pushed work in ${unlinked.length} more ${unlinked.length === 1 ? 'repository has' : 'repositories have'} none:`,
    ...branchLines,
    'Linked:',
    ...linked.map((d) => `  ${d.repository} · ${d.url}`),
    `The work item stays In Progress: Motir completes ${key} when its LINKED pull requests`,
    'merge, so the first merge would close it with the work above still open. Link the pull',
    `request for each branch above (or open it) and move ${key} to Implemented, or re-run it`,
    `with \`motir run ${key}\`.`,
  ].join('\n');
}

/**
 * The listed repositories a run that reached Implemented pushed nothing to (MOTIR-10888) — no
 * pull request is expected from them, and saying so is what tells a person reading the run
 * that a repository was left alone rather than forgotten.
 */
export function renderUnpushedRepositories(
  key: string,
  unlinked: readonly Pick<UndeliveredRepository, 'repository' | 'branch'>[],
): string {
  return [
    `${key}: no work was pushed to ${unlinked.length === 1 ? 'this repository' : 'these repositories'}, so ${unlinked.length === 1 ? 'it has' : 'they have'} no pull request:`,
    ...unlinked.map((u) => `  ${u.repository ?? '(unpinned)'} · ${u.branch ?? '(no branch)'}`),
  ].join('\n');
}

/**
 * What the human should do after the agent FAILS. The item deliberately stays
 * `in_progress` — the work was started and is half-done, so silently reverting
 * it to `todo` would hide that. It is added to the session exclude list instead,
 * so the next `motir next` moves on rather than re-picking the same failure.
 */
export function renderAgentFailure(
  key: string,
  exitCode: number,
  dispatch?: DispatchPrompt,
): string {
  const lines = [
    `${key}: agent exited ${exitCode}. The item stays In Progress (nothing was reverted).`,
    `It is excluded from the next \`motir next\` in this session; re-run it with \`motir run ${key}\`.`,
  ];
  // MOTIR-3136 — how WIDE the half-done work is. The policy above is unchanged;
  // what a person reading a failed multi-repository run cannot otherwise tell is
  // how many checkouts they may now have to look in.
  const repos = dispatch ? repoSet(dispatch) : [];
  if (repos.length > 0) {
    lines.push(
      `${key} ships in ${repos.length} repositories (${repos.map((r) => r.name).join(', ')}),`,
      'so partial work may be sitting in more than one checkout.',
    );
  }
  return lines.join('\n');
}

/**
 * WHY this run is not dispatching a card it was told to take (MOTIR-3048).
 *
 * The server refused the claim, and the refusal DISCRIMINATES — so this does
 * too. `taken` is somebody else's live work and the answer is a name; the
 * others are a state the card is in and the answer is that state. Collapsing
 * the two into "could not claim it" is exactly what the outcome vocabulary
 * exists to prevent: a loser that cannot say who won learns nothing it can act
 * on.
 */
export function renderClaimRefusal(claim: WorkItemClaim): string {
  const where = `It is at ${claim.status.key}.`;
  if (claim.outcome === 'taken') {
    const holder = claim.assignee?.name ?? claim.transitionedBy?.name ?? null;
    return [
      `${claim.key}: already claimed${holder ? ` by ${holder}` : ' by somebody else'} — not dispatching.`,
      `${where} Two agents on one work item is the failure this refusal exists to prevent;`,
      'nothing was changed. Take it over by hand if you know the other run is dead.',
    ].join('\n');
  }
  return [
    `${claim.key}: not claimable — not dispatching.`,
    `${where} A run claims from the TO-DO category only, so a work item that is under`,
    'review, being re-planned, or finished is not work an agent may be started on.',
    'Nothing was changed.',
  ].join('\n');
}

/** The per-item outcome lines of a `complete_session` bulk close-out. */
export function renderSessionOutcomes(
  sessionBranch: string,
  results: { key: string; outcome: string; reason?: string | null }[],
): string {
  if (results.length === 0) return `No work items are recorded on "${sessionBranch}".`;
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const head =
    `Completed session "${sessionBranch}": ` +
    Object.entries(counts)
      .map(([outcome, n]) => `${n} ${outcome.replace('_', ' ')}`)
      .join(', ') +
    '.';
  const detail = results.map((r) => `  ${r.key}: ${r.outcome}${r.reason ? ` — ${r.reason}` : ''}`);
  return [head, ...detail].join('\n');
}

// ── the submitted RE-PLAN (MOTIR-3018) ──────────────────────────────────────

/**
 * The status a card sits at once its agent has said "this card is wrong"
 * (MOTIR-2425): the prompt's THE-CARD-IS-WRONG branch tells it to revert,
 * comment the finding, move the card HERE, submit a detached plan and stop —
 * then exit 0.
 *
 * ⚠️ AN EXIT CODE CANNOT TELL THE TWO OUTCOMES APART. A finished card and a
 * refused one both leave the agent exiting 0, and every dispatch path used to
 * read that as success and drive the card onward — into a transition the
 * workflow does not have (`planning` goes only to In Progress, To Do or
 * Cancelled), so the close-out did not merely record the wrong thing, it threw.
 * The card's own reproduction has the verbatim failure per entry point.
 *
 * Duplicated as a literal in `commands/dispatch.ts` for `pickWarning`, which
 * reads it BEFORE dispatch; this one is the after-the-agent read.
 */
export const PLANNING_STATUS = 'planning';

/**
 * Did the agent park this card with a submitted re-plan?
 *
 * ⚠️ THE COST IS ONE EXTRA READ PER DISPATCHED ITEM, and it is paid deliberately
 * rather than avoided. The card asked for the status that a call already in the
 * path returns — and after the agent exits there is no such call: the only
 * things between `runAgent` and the close-out are `workReachedRemote` (local
 * git) and the close-out write itself. `/api/v1` has exactly one work-item read
 * (`getWorkItem`), so the honest options were this read or inferring the state
 * from the close-out's own REFUSAL. The refusal was rejected: it means writing
 * first and asking afterwards, it identifies the state by an error rather than
 * by data (the 422 carries the ALLOWED targets, never the current status), and
 * it would leave `markIntegrated`'s branch stamp riding on a call the run
 * expects to fail. So: one `GET /api/v1/work-items/{key}` per item that exits
 * 0 — roughly a 20% increase on a per-item budget of four to five requests, and
 * nothing at all on the failure paths, which return before reaching here.
 *
 * A read that FAILS is not a re-plan. The status is the only thing this decides,
 * and a transport error says nothing about it — so the caller falls through to
 * today's close-out, which then surfaces its own error rather than swallowing
 * two.
 */
export async function agentSubmittedReplan(
  client: { getWorkItem(key: string): Promise<{ item: { status: string } }> },
  key: string,
): Promise<boolean> {
  try {
    const detail = await client.getWorkItem(key);
    return detail.item.status === PLANNING_STATUS;
  } catch {
    return false;
  }
}

/**
 * What the human is told when the agent refused the card.
 *
 * ⚠️ THIS IS NOT A FAILURE, and the text has to say so in its first line. An
 * agent that reads its card, finds the premise false and parks it is the
 * protocol working — the single most valuable thing an unattended run produces
 * — and an operator who reads it as an error learns to distrust the one signal
 * that was supposed to be trustworthy.
 */
export function renderReplanSubmitted(key: string): string {
  return [
    `${key}: the agent refused the work item and submitted a re-plan — this is a correct outcome, not a failure.`,
    'The work item is left in Planning exactly where the agent put it: nothing was recorded as',
    'implemented, no session branch was claimed, and no status was moved by this run.',
    'The plan is waiting for a human in Motir. Review it, then re-run the item if it survives.',
  ].join('\n');
}

// ── the per-run FINDINGS POLICY, at the command line (MOTIR-3022) ───────────

/**
 * The two `--disable-*` flags and their hidden `--no-*` aliases, as commander
 * hands them over.
 *
 * ⚠️ TWO ATTRIBUTES PER CAPABILITY, deliberately. `--disable-log-bug` registers
 * as `disableLogBug`; `--no-log-bug` is a commander NEGATED boolean and
 * registers as `logBug`, defaulting to `true` when nothing is passed. There is
 * no way to point two flags at one attribute, so the pair is normalised in ONE
 * place — {@link findingsPolicyOf} — rather than at four call sites that could
 * drift.
 */
export interface FindingsPolicyOptions {
  /** `--disable-log-bug` — the primary spelling. */
  disableLogBug?: boolean;
  /** `--disable-replan` — the primary spelling. */
  disableReplan?: boolean;
  /** `--no-log-bug` — the hidden alias. `false` when it was passed. */
  logBug?: boolean;
  /** `--no-replan` — the hidden alias. `false` when it was passed. */
  replan?: boolean;
}

/**
 * The `findingsPolicy` query value to send, or `undefined` for "send nothing".
 *
 * ⚠️ ABSENT, NOT `''`, WHEN NOTHING IS DISABLED. An omitted parameter is how the
 * server is told to render the COMPLETE protocol, and it is the shape every
 * existing caller already has — so a run with no flags produces a request
 * byte-identical to the one it produced before this flag existed. Sending an
 * empty string would mean the same thing and look like a change.
 *
 * The token vocabulary is the SERVER's (`log-bug` / `replan`), not the flag's:
 * the wire names the CAPABILITY, and `--disable-` is one client's ergonomics.
 */
export function findingsPolicyOf(opts: FindingsPolicyOptions): string | undefined {
  const disabled: string[] = [];
  if (opts.disableLogBug || opts.logBug === false) disabled.push('log-bug');
  if (opts.disableReplan || opts.replan === false) disabled.push('replan');
  return disabled.length > 0 ? disabled.join(',') : undefined;
}

/**
 * The one line every command's summary carries, so a run that FILED nothing is
 * distinguishable from a run that was not allowed to.
 *
 * Without it the two are identical in the output, and an operator reading a
 * quiet summary cannot tell whether their agent found nothing or was told not to
 * look.
 */
export function renderFindingsPolicy(opts: FindingsPolicyOptions): string {
  const policy = findingsPolicyOf(opts);
  if (policy === undefined) return 'Findings policy: bug filing and re-planning both permitted.';
  const off = policy
    .split(',')
    .map((token) => (token === 'log-bug' ? 'bug filing' : 're-planning'))
    .join(' and ');
  return `Findings policy: ${off} DISABLED for this run (the agent comments instead).`;
}

/**
 * `--auto-approve-replan` on a command that has no loop to continue into.
 *
 * ⚠️ REGISTERED IN ORDER TO BE REFUSED. A flag a module guards but the command
 * never declares is rejected by commander first, with a bare `unknown option`,
 * and the guard carrying the real guidance is unreachable — the MOTIR-1828 /
 * MOTIR-1830 defect, shipped twice in this package. The message says WHY rather
 * than only WHERE, because "use it on `auto`" invites someone to move the flag
 * to `batch` next.
 */
export function autoOnlyFlagError(command: 'run' | 'next' | 'batch'): {
  message: string;
  hint: string;
} {
  const why =
    command === 'batch'
      ? 'A batch freezes its ready set before the first agent starts and never re-reads it, so ' +
        'work items a newly-approved plan creates would be approved and then never dispatched.'
      : `\`motir ${command}\` dispatches ONE item and exits, so there is no continuation for an ` +
        'approval to feed.';
  return {
    message: `--auto-approve-replan is a \`motir auto\` flag. ${why}`,
    hint: 'Run `motir auto --auto-approve-replan` to approve a submitted re-plan and keep going.',
  };
}

/**
 * `--auto-approve-replan` together with `--disable-replan` (or its alias).
 *
 * Refused at parse time rather than resolved by precedence: the two say opposite
 * things about the same capability, and silently honouring one would leave the
 * operator believing the other.
 */
export function contradictoryReplanFlags(opts: FindingsPolicyOptions): string | null {
  if (!(opts.disableReplan || opts.replan === false)) return null;
  const spelling = opts.disableReplan ? '--disable-replan' : '--no-replan';
  return (
    `--auto-approve-replan and ${spelling} contradict each other: one approves a submitted ` +
    're-plan, the other stops the agent from submitting one at all.'
  );
}

// ── the PROMPT ECHO, at the command line (MOTIR-3052) ───────────────────────

/**
 * `--print-prompt` — echo each assembled prompt to stderr AS IT IS SENT.
 *
 * ⚠️ NOT `--print`, and the one-word gap is the whole hazard. `--print` prints
 * the prompt INSTEAD of launching an agent (and is refused outright on `auto` /
 * `batch`, which have nobody to paste it to); this one prints it IN ADDITION to
 * the run, and is supported everywhere — an unattended loop is exactly where a
 * transcript is worth having. The two attributes are distinct (`print` vs
 * `printPrompt`), so the existing refusals cannot catch this flag; the reason
 * they must not is stated on those guards.
 */
export interface PromptEchoOptions {
  /** `--print-prompt` — echo the assembled prompt to stderr as it is dispatched. */
  printPrompt?: boolean;
}

/**
 * The header that opens one echoed prompt.
 *
 * In `auto`, `batch` and a scoped `run` many prompts stream past in a single
 * invocation, and an unheadered wall of text is not a transcript — so every
 * block names the work item, and names the SESSION BRANCH as well whenever the
 * dispatch carries one (`session_lineage`), because on that path the prompt's
 * git instructions are only interpretable against the branch they name.
 */
export function renderPromptEchoHeader(key: string, dispatch: DispatchPrompt): string {
  const lineage =
    dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch
      ? ` · ${dispatch.sessionBranch}`
      : '';
  return `──── PROMPT SENT · ${key}${lineage} ────`;
}
