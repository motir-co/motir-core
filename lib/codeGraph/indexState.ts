// THE PER-REPO INDEX STATE — ONE derivation, read by every surface
// (Story MOTIR-4669 · MOTIR-4724).
//
// Four states, and until this module there was no place that could name all
// four. `Settings → Organisation → Git` (MOTIR-4680) shipped rendering TWO,
// deliberately and with the gap asserted, because the other two were blocked by
// properties the owning code documents about itself:
//
//   * `jobRunRepository.listSucceededCodeGraphIndexRepoRefs` — *"Staleness (graph
//     commit vs the default-branch head) is MOTIR-1754/1766's axis and
//     deliberately not read here."*
//   * `findRunningCodeGraphIndexForWorkspace` — *"a `running` row has no
//     `output.repoRef` … so the ledger cannot say WHICH repo a running row
//     belongs to — only that one is in flight."*
//
// ⚠️ ONE FUNCTION, ONE CALL PATH, and `tests/codeGraph/indexState.test.ts`
// asserts no second implementation of "stale" exists under `lib/`. The reason is
// the card's own: the organisation inventory, the `Code` page (MOTIR-1754) and
// any future surface must not be able to disagree about what the word means. A
// second comparison written at a call site would not be caught by a type — it
// would just be a different answer on a different screen.

/** What Motir knows about a repository's code graph. */
export type CodeGraphIndexState =
  /** No succeeded index run has ever carried this repository's ref. */
  | 'never'
  /** An index run is in flight FOR THIS REPOSITORY, right now. */
  | 'indexing'
  /** A graph exists and matches the default branch's head, as last observed. */
  | 'indexed'
  /** A graph exists and the default branch has moved past what it was built from. */
  | 'stale';

/** The facts the derivation reads — all of them motir-core's own columns. */
export interface CodeGraphIndexFacts {
  /** True when a succeeded `system.code-graph-index` run carries this repo's ref. */
  hasSucceededIndex: boolean;
  /** `github_repo.default_branch_head_sha` — what the push webhook last saw. */
  defaultBranchHeadSha: string | null;
  /** `github_repo.indexed_head_sha` — the head observed when the index STARTED. */
  indexedHeadSha: string | null;
  /**
   * True when `github_repo.indexing_run_id` names a run that is STILL `running`.
   *
   * ⚠️ The caller resolves this, and it must resolve it against the ledger rather
   * than against the column alone. The column is a POINTER, not a state: a run
   * that crashed leaves it set forever, and a row that read `indexing` for ever
   * after would be worse than one that never read it at all.
   */
  hasRunningIndex: boolean;
}

/**
 * THE ONE DERIVATION.
 *
 * The order of the arms is the whole content of the function, so each is stated:
 *
 *  1. **`indexing` wins over everything.** A repository being indexed right now is
 *     what a person most wants to know, and it is true whatever the shas say — a
 *     re-index of a stale graph is in flight, not stale.
 *  2. **`never` before any comparison.** With no succeeded run there is no graph,
 *     so there is nothing for a head to be ahead OF. Reaching the sha comparison
 *     first would report `stale` for a repository that was never indexed, which
 *     names the wrong remedy: one needs a first index, the other a refresh.
 *  3. **`stale` only when BOTH shas are known and DIFFER.** This is the rule the
 *     module exists to hold, and the null handling is the load-bearing half —
 *     see below.
 *  4. **`indexed` otherwise**, which includes every not-yet-known case.
 *
 * ⚠️ NULL IS "NOT KNOWN YET", NEVER "UP TO DATE" — AND NEVER "STALE".
 * Both shas are null for every repository that predates this card's migration,
 * and `defaultBranchHeadSha` stays null until somebody pushes. Treating a missing
 * comparand as a difference would flip the entire estate to `stale` on deploy,
 * telling every customer their code graph was behind on no evidence at all. So a
 * missing sha falls through to `indexed`: the honest answer is "a graph exists
 * and nothing has told us it is behind."
 *
 * The bias is deliberate and it runs the OTHER way from the one this story
 * refused: `indexed` here never claims currency it cannot support, because it is
 * reached only when a graph provably exists. What it declines to do is invent a
 * `stale` from an absence.
 */
export function deriveCodeGraphIndexState(facts: CodeGraphIndexFacts): CodeGraphIndexState {
  if (facts.hasRunningIndex) return 'indexing';
  if (!facts.hasSucceededIndex) return 'never';
  if (graphTrailsHead(facts.indexedHeadSha, facts.defaultBranchHeadSha)) return 'stale';
  return 'indexed';
}

/**
 * DOES THE GRAPH TRAIL THE DEFAULT BRANCH? — the sha comparison itself, and its one
 * home (MOTIR-10094). True only when BOTH shas are known and DIFFER; a missing
 * comparand is "not known yet", never a difference (the null rule above).
 *
 * It is the comparison arm 3 makes, lifted out so a reader that needs the bare
 * fact — the code-graph READ, which reports what the graph is missing even while
 * a re-index is in flight and the state therefore reads `indexing` — asks this
 * function rather than writing a second comparison.
 */
export function graphTrailsHead(indexedSha: string | null, headSha: string | null): boolean {
  return indexedSha !== null && headSha !== null && indexedSha !== headSha;
}
