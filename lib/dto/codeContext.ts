import type { CodeGraphIndexState } from '@/lib/codeGraph/indexState';

// The CODE-CONTEXT DTOs (Story MOTIR-1754 · MOTIR-1767) — what a PROJECT's
// planning surfaces are told about the code Motir can read for them.
//
// ⚠️ THERE IS NO VERDICT TYPE HERE, AND THAT IS THE POINT OF THIS FILE'S SECOND
// REVISION. It first shipped a `CodeRepoVerdict` of its own —
// `current | stale | indexing | never_indexed` — computed by a `resolveVerdict`
// in the service beside it. `lib/codeGraph/indexState.ts` (MOTIR-4724) is THE ONE
// derivation of those states, `tests/codeGraph/indexState.test.ts` asserts that no
// second implementation of "stale" exists under `lib/`, and that module's own
// header names *the `Code` page (MOTIR-1754)* as a surface that must not be able
// to disagree with it. So the state is IMPORTED, never re-declared: a second
// union would compile, diverge silently, and put a different answer on a
// different screen.
//
// ⚠️ AND THE VOCABULARY IS NOT A RENAME OF THE OLD ONE. The states are
// `never | indexing | indexed | stale`, and `indexed` is deliberately NOT
// `current`: a null head sha means "not known yet", never "up to date", so
// claiming currency would tell somebody their graph matches their code at the
// exact moment they are deciding whether to trust a plan built from it.

/** One repository of the PROJECT's configured set, with what Motir knows about its graph. */
export interface CodeContextRepoDTO {
  /** `owner/name` — the ref the code graph is keyed on. */
  repoRef: string;
  /** The git-provider discriminator (`github` / `gitlab`). */
  provider: string;
  /** The shipped four-state answer. Imported, never re-derived. */
  indexState: CodeGraphIndexState;
  /**
   * When the graph was last built. Rendered as "indexed <when>" and NEVER used to
   * decide staleness — `indexedAt` is a timestamp and staleness is a sha
   * comparison, which is the distinction `indexState.ts` exists to hold.
   */
  indexedAt: Date | null;
  /**
   * How far the default branch has moved past the graph, IN COMMITS.
   *
   * ⚠️ `null` IS A FIRST-CLASS ANSWER, not a gap: the pair was never counted, has
   * since moved, or has no common ancestor. It is emphatically not `0`, which
   * would say the graph MATCHES the code.
   *
   * ⚠️ THIS FIELD USED TO READ *"ALWAYS `null` TODAY"* and no longer is —
   * MOTIR-4644 shipped its producer (`lib/codeGraph/driftCount.ts` plus the
   * off-render-path sweep), so a counted pair now carries its number. The note
   * is corrected rather than deleted because the REASON it was null is still the
   * reason the count needs a producer at all: telling `stale` from `indexed`
   * needs only a sha inequality, which `indexState.ts` does, while COUNTING the
   * commits between two shas needs a commit-graph read neither column holds.
   *
   * It is carried rather than dropped because a CONSUMER already depends on the
   * distinction: `isBadlyStale` pauses the auto-cadence on a THRESHOLD, never on
   * any drift, and `indexState === 'stale'` cannot stand in for it — an active
   * repository is a few commits behind between every push, so conflating the two
   * would pause the cadence permanently for exactly the projects doing the most
   * work.
   */
  commitsBehind: number | null;
  /**
   * THE PAIR THE DRIFT IS ABOUT (MOTIR-10094): the commit the graph was built
   * from, and the default branch's head as last mirrored — `null` while either is
   * not known yet. Facts, never a verdict: whether the two differ is
   * `graphTrailsHead`'s (`lib/codeGraph/indexState.ts`), and what changed between
   * them is a host compare made on demand by the code-graph read.
   */
  indexedSha: string | null;
  defaultHead: string | null;
  /**
   * ⚠️ IS THE REFRESH DEAD? (Story MOTIR-1754 · MOTIR-2105.)
   *
   * `true` when the run that last claimed this repository reached a TERMINAL
   * state — `failed` or `abandoned` — so the graph will keep drifting until
   * somebody acts. `false` is *nothing says it is dead*, which covers a healthy
   * pipeline that has simply not run yet as well as one that just succeeded.
   *
   * ⚠️ IT IS THE FACT THAT WAS ONLY EVER IN THE DLQ. A stale graph whose refresh
   * dead-lettered and a stale graph with a refresh queued behind it were the
   * same thing to every product surface: both `stale`, both still answering
   * every tool call, and only one of them ever getting better. 35 dead-letters
   * accumulated over 48 hours and nobody noticed, because the one surface that
   * knew was a job-runs tab where that volume reads as background.
   *
   * ⚠️ NEVER INFERRED FROM DRIFT. Being far behind is not evidence that anything
   * failed — an active repository is behind between every push.
   */
  refreshFailing: boolean;
  /**
   * ⚠️ THE LAST INDEX WAS REFUSED FOR SIZE (MOTIR-7132 · Story MOTIR-7092), or
   * `null`. CUSTOMER-FACING: the row tells the person the graph's size and the
   * supported maximum, in bytes, from `GithubRepo.indexRefused*` (written when a
   * run is refused for size, cleared by the next run that indexes — MOTIR-7130).
   *
   * Numbers, never a sentence: the row renders its own copy in each locale, so
   * no motir-ai wording reaches a customer. When it is set, the row's refusal
   * block REPLACES the generic "not updating" line (design/code-context §17.3).
   */
  graphTooLarge: { sizeBytes: number; capBytes: number } | null;
}

/** The project's whole code-context answer. */
export interface CodeContextDTO {
  /**
   * Whether the planner would get `context.code` at all for this project — i.e.
   * whether its configured set contains at least one REALIZED repository.
   */
  hasCodeContext: boolean;
  /** The project's repositories, in the set's own order. Empty when there are none. */
  repos: CodeContextRepoDTO[];
  /**
   * Whether anybody has reported implementing work in this project. Drives the
   * "connect your code" prompt: a project nobody has built in yet is not one to
   * nag. Deliberately NOT "any done item" (a migrated tracker is full of those,
   * implemented by nobody through Motir) and NOT "any pull-request link" (which
   * presumes the very connection the affordance is asking for).
   */
  hasImplementedWork: boolean;
}
