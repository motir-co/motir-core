// SUPERSEDE BY RUN, NOT BY NAME (MOTIR-3209).
//
// A check row's identity used to be `(pullRequest, commitSha, checkName)`, a key
// that quietly assumes ONE workflow run per commit. `cancel-in-progress`
// (MOTIR-3106) made two runs at one commit ordinary and deliberate — a label
// added seconds after `gh pr create` starts a second run and the first is
// cancelled — and the two runs do not use the same check NAMES. So the loser's
// rows outlived the winner's exactly where the names differ:
//
//   * a matrix job cancelled BEFORE expansion reports the literal template as
//     its name (`Vitest (${{ matrix.shard }}/${{ matrix.total }})`), which the
//     winner's `Vitest (1/3)` can never overwrite — a different key;
//   * `Deploy to Fly` is the same trap from the other side: `cancelled` maps to
//     `failure` in the loser, `skipped` maps to `neutral` in the winner, and a
//     neutral records nothing, so nothing ever clears the stale failure.
//
// Rows now carry the RUN they came from, and this module is the ONE place that
// says which of those runs still gets a vote. Both derivations call it — the
// feedback comment's `deriveCiState` and the Development surface's
// `derivePrCiState` — because two opinions about one commit is precisely what
// MOTIR-2946 removed.
//
// ── WHY THE RULE IS "SHARES A CHECK NAME", NOT "IS THE SAME WORKFLOW" ───────
// Superseding must be per WORKFLOW and never per sha: motir-core runs `ci.yml`
// and `codeql.yml`, GitHub gives each workflow RUN its own check suite, and
// "newest suite at the sha wins" would let a CI re-run hide CodeQL's verdict.
//
// The obvious implementation — group by workflow id — is not available. A
// `check_run` webhook payload carries `check_suite.id` and the App slug and
// NOTHING that names the workflow: both `ci.yml` and `codeql.yml` arrive as the
// same `github-actions` App, and `details_url` names the RUN, not the workflow.
// (Verified against PR #2192's five suites at sha `82d6e346`: two CI runs, two
// CodeQL runs, one advanced-security suite — four of them indistinguishable by
// app slug.)
//
// So the workflow identity is reconstructed from what the rows themselves say: a
// run REPLACES an earlier run when it re-reports a check the earlier one
// reported. Two runs of `ci.yml` share `TypeScript`, `Next.js build`,
// `CI complete`; a CI run and a CodeQL run share no CHECK. The one residue,
// stated rather than hidden: a run cancelled so early that NONE of its checks
// is re-reported by its replacement is not recognised as superseded — it keeps
// today's behaviour rather than a worse one.
//
// ── A SUITE'S OWN ROLL-UP ROW IS NOT A CHECK, AND IT IS NOT EVIDENCE ────────
// (MOTIR-6274.) "Share no check" used to read "share nothing", and that was
// false: a GitHub `check_suite` event is recorded as a row named by the App
// SLUG, and every Actions workflow is the same App — `ci.yml`, `codeql.yml` and
// `acceptance.yml` all write a `github-actions` row, each under its own suite.
// Counted as a shared name, it made every Actions suite at a commit a "re-run"
// of every other, and the newest retired the rest wholesale: on motir-core#3112
// @ `88508fb2` CodeQL's and the acceptance lane's suites were discarded and the
// verdict was formed over CI's alone ("4 of 43 checks" where the host held 46).
// Which workflow survived depended on the order GitHub minted the suite ids.
//
// So a row marked `suiteAggregate` (set by the GitHub `check_suite` parse, and
// by nothing else) is left out of the shared-name test on BOTH sides: it can
// neither retire a suite nor be the reason one is retired. It still VOTES —
// it is the suite's own conclusion — and it still goes with its suite when that
// suite is replaced by a real re-run. A GitLab pipeline row is deliberately NOT
// one: GitLab has one pipeline per commit per project, so its shared `pipeline`
// name IS the re-run evidence there. The residue widens by exactly one shape,
// stated: a suite whose only recorded row is its roll-up (no check of its own
// ever arrived) is no longer retired by a newer suite of the same App — it
// cannot be told apart from a different workflow, and "keep its vote" is the
// failure that can be seen, where "discard a workflow" was the one that could
// not.
//
// ── WHICH RUN IS "LATER" IS THE PROVIDER'S ORDER, NOT OUR DELIVERY ORDER ────
// Deliberately NOT the row's `createdAt`. That timestamp records when a webhook
// reached us, and a backlog that delays the cancelled run's first delivery past
// the winner's would invert the answer and hand the verdict straight back to the
// run this module exists to retire. A suite id is minted by the host in creation
// order (87626130152 < 87626227873 for the two CI runs above; 87626129473 <
// 87626226092 for the two CodeQL ones), so it says what we actually mean.

//
// ── A RE-RUN ATTEMPT IS NOT A NEW SUITE (MOTIR-11827) ───────────────────────
// Everything above supersedes by SUITE, and that is only half of GitHub's
// re-run model. "Re-run jobs" and "Re-run failed jobs" do not mint a suite: every
// attempt of one workflow run reports its check runs under the SAME
// `check_suite.id`. So the trap this module closed for two RUNS reopens for two
// ATTEMPTS of one run — on motir-core#4353 @ `b50389ac` attempt 1 was cancelled
// (template-named matrix rows, gated jobs, all `cancelled` → `failure`),
// attempt 3 went green with the gated jobs `skipped`, and every attempt-1 failure
// stayed live for good, under suite 120570907095, while GitHub showed 72 green
// and 11 skipped.
//
// The check-run payload names no attempt (`details_url` names the job, and the
// `run_attempt` the Actions API carries needs `actions: read`, which the
// user-facing App does not hold — see `readCommitActionsSuites`). What the
// rows DO carry is the suite's own roll-up, and GitHub forms a suite's
// conclusion over its LATEST attempt. A roll-up that reads `success` therefore
// says no check of the latest attempt failed; a `failure` row in that suite that
// finished no later than the roll-up did can only be an earlier attempt's. That
// row is retired. A failure that finished AFTER the green roll-up — a newer
// attempt already running and red before its own roll-up lands — keeps its vote,
// and so does every row with no time on it (it cannot be ordered).
//
// The mirror half lives at ingestion: a `skipped` (neutral) delivery used to be
// dropped before it reached the row, so a gated job skipped by the later attempt
// never cleared the failure the cancelled attempt left at the SAME key. It now
// settles that row when it is newer (`changeRequestCiFeedback.applyOneCiDelivery`).
// Successes from an earlier attempt are left alone: "Re-run failed jobs" carries
// them into the new attempt rather than running them again.
//
// ── AND A RED ROLL-UP A NEWER ATTEMPT HAS REPLACED IS NOT A VOTE (MOTIR-12200) ─
// The green arm above has a red twin that the webhook never closes on its own.
// When attempt N fails, GitHub completes the suite red and we record that roll-up.
// When attempt N+1 starts, GitHub reopens the SAME suite, but it sends the
// `requested` / `rerequested` actions of `check_suite` only to the App that OWNS
// the suite (GitHub Actions) — an App watching someone else's suite hears only
// `completed`. So nothing reopens our roll-up row: attempt N's `failure` stays on
// it until attempt N+1 completes, and the fold ranks failure above pending, so
// the pull request read "Checks failing" for the whole re-run (motir-infra#167,
// run 45511434917, suite 123146961591: attempt 1 cancelled at 23:50:53, roll-up
// red at 23:50:55, attempt 2's `checks` pending from 23:52:29).
//
// A suite's roll-up is formed when its attempt ENDS, after every one of that
// attempt's checks has finished. A check row in the same suite whose own time is
// LATER than the red roll-up therefore belongs to an attempt the roll-up does not
// describe, and the roll-up is retired. Its information is not lost: the failing
// checks of the attempt it summarised still vote at their own rows until the new
// attempt re-reports them, and the new attempt's own roll-up, when it lands,
// votes in its place. A red roll-up with no newer row in its suite, or with no
// time on it, keeps its vote — that is the current attempt's verdict. Only the
// suite's OWN rows decide, so a CI re-run never retires CodeQL's red roll-up
// (MOTIR-6274).

/** The row fields the supersession rule reads — a slice both call sites have. */
export interface SuiteScopedCheckRow {
  checkName: string;
  /** The normalized conclusion (`success` · `failure` · `pending` · `neutral`).
   *  Read by the attempt rule (MOTIR-11827): only a `failure` is retired by a
   *  green roll-up, and only a `success` roll-up retires a check. A `failure`
   *  roll-up is itself retired by a newer check in its suite (MOTIR-12200). */
  conclusion: string;
  /** WHEN, by the provider's clock, the row reached `conclusion` — its finish for
   *  a terminal row, its start for a pending one (MOTIR-10456). `null` = unknown:
   *  such a row cannot be ordered and is never retired by the attempt rule.
   *  Required rather than optional so a reader cannot leave it out of its select
   *  and quietly read the old, attempt-blind verdict (MOTIR-11827). */
  conclusionAt: Date | null;
  /** The CI run this check belongs to. `''` means NO run identity: a row
   *  written before the column existed, or a provider that reports none (a
   *  legacy commit-`status` event). Such rows form ONE group, which supersedes
   *  nothing and is superseded by nothing unless a real run re-reports one of
   *  their names — i.e. exactly the behaviour those rows had before. */
  checkSuiteId: string;
  /** A suite's OWN roll-up row rather than a check (MOTIR-6274) — its name is
   *  the App's, not the workflow's, so it is never evidence that two suites are
   *  one workflow. Omitted = a check, which is what every pre-column row and
   *  every caller-built row is. */
  suiteAggregate?: boolean;
}

/**
 * The rows at ONE commit that still get a vote — every row whose run has not
 * been replaced by a later run at that commit.
 *
 * Callers must pass rows for a single sha; this rule says nothing about which
 * commit is current (`derivePrCiState` picks that first, and the feedback
 * consumer reads one sha by construction).
 *
 * Order is preserved, so a caller's `orderBy` still holds.
 */
export function liveCheckRows<T extends SuiteScopedCheckRow>(rows: T[]): T[] {
  return withoutEarlierAttempts(liveSuites(rows));
}

/** The run-level rule (MOTIR-3209 · MOTIR-6274): drop every suite a later suite
 *  at the commit replaced. */
function liveSuites<T extends SuiteScopedCheckRow>(rows: T[]): T[] {
  if (rows.length === 0) return rows;

  // Every suite at the commit gets an entry — a suite whose only row is its
  // roll-up included, with an EMPTY name set, so it is ordered and can be read
  // but shares nothing. The roll-up's own name is never added (MOTIR-6274).
  const names = new Map<string, Set<string>>();
  for (const row of rows) {
    let known = names.get(row.checkSuiteId);
    if (!known) {
      known = new Set<string>();
      names.set(row.checkSuiteId, known);
    }
    if (row.suiteAggregate !== true) known.add(row.checkName);
  }
  if (names.size === 1) return rows;

  const ordered = [...names.keys()].sort(compareSuiteIds);
  const superseded = new Set<string>();
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i]!;
    const mine = names.get(id)!;
    for (let j = i + 1; j < ordered.length; j++) {
      if (sharesAName(mine, names.get(ordered[j]!)!)) {
        superseded.add(id);
        break;
      }
    }
  }
  if (superseded.size === 0) return rows;

  return rows.filter((row) => !superseded.has(row.checkSuiteId));
}

/**
 * The attempt-level rule, both arms, applied per suite to the suites `liveSuites`
 * kept — never across suites: a roll-up speaks for its own workflow run and
 * nothing else, so CodeQL's red is never retired by CI's green (MOTIR-6274).
 *
 *  - green arm (MOTIR-11827): inside a suite whose OWN roll-up is a green it
 *    reached at a known time, a `failure` row that finished no later than that
 *    roll-up is an EARLIER ATTEMPT's, and it does not vote;
 *  - red arm (MOTIR-12200): a `failure` roll-up older than a check row of its own
 *    suite describes an attempt a newer one has replaced, and it does not vote.
 *
 * A row that cannot be ordered — no time on it, or none on the roll-up — keeps
 * its vote, which is the behaviour before this rule.
 */
function withoutEarlierAttempts<T extends SuiteScopedCheckRow>(rows: T[]): T[] {
  const greenAt = new Map<string, number>();
  const newestCheckAt = new Map<string, number>();
  for (const row of rows) {
    if (row.checkSuiteId === '' || row.conclusionAt == null) continue;
    const at = row.conclusionAt.getTime();
    if (row.suiteAggregate === true) {
      if (row.conclusion !== 'success') continue;
      const known = greenAt.get(row.checkSuiteId);
      if (known === undefined || at > known) greenAt.set(row.checkSuiteId, at);
    } else {
      const known = newestCheckAt.get(row.checkSuiteId);
      if (known === undefined || at > known) newestCheckAt.set(row.checkSuiteId, at);
    }
  }
  if (greenAt.size === 0 && newestCheckAt.size === 0) return rows;

  const kept = rows.filter((row) => {
    if (row.conclusion !== 'failure' || row.conclusionAt == null) return true;
    const at = row.conclusionAt.getTime();
    if (row.suiteAggregate === true) {
      // The red arm: a newer check in this suite means a newer attempt.
      const newest = newestCheckAt.get(row.checkSuiteId);
      return newest === undefined || at >= newest;
    }
    const green = greenAt.get(row.checkSuiteId);
    return green === undefined || at > green;
  });
  return kept.length === rows.length ? rows : kept;
}

/**
 * Oldest run first, as a TOTAL order — every pair is comparable and the result
 * is transitive, so no two runs can retire each other.
 *
 * Three tiers, and only the first two occur in practice. `''` (no run identity)
 * is always OLDEST: those rows are either pre-migration or from a provider that
 * reports no run at all, and in both readings nothing about them is newer than a
 * run that named itself. Then the numeric ids the hosts actually mint, by value.
 * The string tier is a deterministic fallback for an id shape neither host uses
 * today — a repo talks to ONE provider, so a numeric/non-numeric mix cannot
 * arise from the field itself.
 */
function compareSuiteIds(a: string, b: string): number {
  const [tierA, valueA] = suiteRank(a);
  const [tierB, valueB] = suiteRank(b);
  if (tierA !== tierB) return tierA - tierB;
  if (valueA !== valueB) return valueA < valueB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function suiteRank(id: string): [number, number] {
  if (id === '') return [0, 0];
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) ? [1, numeric] : [2, 0];
}

function sharesAName(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const name of small) if (large.has(name)) return true;
  return false;
}
