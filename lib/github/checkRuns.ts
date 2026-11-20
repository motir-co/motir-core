import { githubFetch } from '@/lib/github/githubFetch';
import { mintInstallationToken } from './appAuth';
import { githubAppRoleForRepo } from '@/lib/github/appRoleForRepo';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { mapGithubCiConclusion } from '@/lib/git/providers/github';
import type { CiConclusion } from '@/lib/git/types';

// Writing a CHECK RUN — the leaf primitive Motir did not have (MOTIR-3675).
//
// Until this file every GitHub check in the codebase was READ: `parseCiStatusEvent`
// normalizes `check_run` / `check_suite` deliveries, and nothing wrote one. That
// asymmetry was deliberate for as long as a pull request's association with a card
// could be inferred; once MOTIR-3674 retired the parse, a pull request nobody
// linked associates with nothing at all, and the only way that absence becomes
// visible while somebody can still act on it is a check on the pull request
// itself. `docs/decisions/unlinked-pull-request-check.md` is where that was
// decided, including why option B (a workflow job per repository) does not reach
// the population this exists for.
//
// ⚠️ THE PERMISSION MAY NOT BE THERE, AND THAT IS A NORMAL ANSWER, NOT AN ERROR.
// The `motir-integration` App holds `checks: read`; `checks: write` is an ADDITION,
// and GitHub keeps an installation on its OLD permission set until an account
// admin approves the new one. So a deployment can be fully up to date and still be
// refused here, per installation, for as long as nobody has clicked approve —
// measured on 2026-08-27, `POST /check-runs` answers **403 Resource not accessible
// by integration**. Every function below reports that as `not_permitted` rather
// than throwing: the caller is a webhook delivery or an MCP write, and neither may
// fail because a repository has not consented to a check.
//
// A leaf primitive in the `lib/email.ts` sense — SERVICES import it, routes never
// do — and config is read at call time by `mintInstallationToken`, so a
// self-hosted deploy that never wires the App simply cannot reach it.

const GITHUB_API = 'https://api.github.com';

// ⚠️ EVERY PATH SEGMENT THAT REACHES A URL IS VALIDATED FIRST — all FOUR kinds:
// the repository's owner, its name, the commit SHA, and the pull request NUMBER.
// The reason is not the scanner that found them (`js/request-forgery`, on two
// reads and then, once those were guarded, on the number the third one
// interpolates). The values ARRIVE from a webhook payload — GitHub's, signature-checked,
// and mirrored into `github_repo` before this file sees them — so the realistic
// exploit is thin. What is NOT thin is the failure mode: a repository row whose
// `owner` or `name` was written wrong, by any path, turns every call in this file
// into a request to a URL nobody wrote. `..` in a segment walks the API path;
// a `?` or `#` truncates it. A best-effort writer that must never throw is
// exactly the place that would do it silently.
//
// So the guard is a WHITELIST of the grammar GitHub itself accepts, applied at
// the one place a URL is built, and a value outside it produces no request at
// all — which each caller already has an arm for.
//
// ⚠️ AND A NUMERIC SEGMENT IS GUARDED THE SAME WAY, not with `Number.isInteger`.
// A pull request number is arithmetic, so it reads as immune — but it arrives as
// JSON from a webhook body or an MCP argument, and what a sender writes there is
// only a number by convention. `Number.isInteger` also admits values that are
// integers and still not path segments: `1e21` stringifies to `1e+21`, and a
// negative walks a `-` into the path. Constraining what the segment SAYS is the
// same question at all three sites, so it gets the same instrument.
//
// ⚠️ AND THE OWNER AND THE NAME ARE NOT THE SAME GRAMMAR, which is the mistake
// this pair was written with and a test caught: one whitelist of
// `[A-Za-z0-9._-]` for both ADMITS `..`, so the segment the note above names as
// the thing it stops walked straight through it. A GitHub LOGIN is alphanumeric
// and hyphens only, at most 39 characters and never leading with a hyphen — it
// has no `.` to walk with. A repository NAME does take `.` (`.github` is one),
// so there the dot-segments are excluded by name.
const OWNER_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const PULL_NUMBER = /^[1-9][0-9]{0,8}$/;

/** `https://api.github.com/repos/<owner>/<name>`, or null when either segment is
 *  not a thing GitHub could have named. */
function repoUrl(owner: string, name: string): string | null {
  if (!OWNER_SEGMENT.test(owner) || !NAME_SEGMENT.test(name)) return null;
  return `${GITHUB_API}/repos/${owner}/${name}`;
}

/** `<repoUrl>/pulls/<number>`, or null when the number is not one GitHub could
 *  have issued. Separate from `repoUrl` because only one caller addresses a
 *  pull request, and folding it in would put an unused segment in the other
 *  two. */
function pullUrl(base: string, number: number): string | null {
  const segment = String(number);
  if (!PULL_NUMBER.test(segment)) return null;
  return `${base}/pulls/${segment}`;
}

/** The check run's name, as a person reads it in the GitHub UI. Stable: it is
 *  the key this module re-writes in place, and what a branch-protection rule
 *  would name. `docs/mcp.md` documents it by this string. */
export const LINK_CHECK_NAME = 'Motir / work item link';

/** What a write attempt did. `not_permitted` is the App lacking `checks: write`
 *  on this installation — expected, quiet, and never an error; `unavailable` is
 *  GitHub being unreachable or refusing for any other reason. */
export type CheckRunWriteOutcome = 'created' | 'updated' | 'not_permitted' | 'unavailable';

export interface CheckRunSpec {
  installationId: string;
  owner: string;
  name: string;
  /** The commit the check is attached to. A check run belongs to a SHA, not to a
   *  pull request, which is why every caller has to have one. */
  headSha: string;
  /** `success` clears a previous failure in place; `failure` is the hold. */
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
}

interface GithubJson {
  [key: string]: unknown;
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'motir',
    'content-type': 'application/json',
  };
}

/**
 * Find THIS app's existing `LINK_CHECK_NAME` run at `headSha`, if there is one.
 *
 * The idempotence half of the contract (the card's AC 5: *one check, not one per
 * delivery*). `POST /check-runs` always creates, so a redelivery would stack a
 * second identical run on the same commit and the pull request would show two.
 * Filtering by `check_name` narrows to this check; GitHub scopes the listing to
 * the authenticated app on its own, so no `app_id` filter is needed.
 *
 * Returns `null` when there is none, and also when the read fails — a failed read
 * degrades to "create one", which is the safe direction: a duplicate check is
 * ugly, a missing one is the defect this whole story is about.
 */
async function findExistingRun(
  token: string,
  owner: string,
  name: string,
  headSha: string,
): Promise<number | null> {
  const base = repoUrl(owner, name);
  if (base === null || !COMMIT_SHA.test(headSha)) return null;
  let res: Response;
  try {
    res = await githubFetch(
      'checkRuns.write',
      `${base}/commits/${headSha}/check-runs` +
        `?check_name=${encodeURIComponent(LINK_CHECK_NAME)}&per_page=1`,
      { headers: headers(token) },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: GithubJson | null;
  try {
    body = (await res.json()) as GithubJson;
  } catch {
    return null;
  }
  const runs = Array.isArray(body?.['check_runs']) ? (body['check_runs'] as unknown[]) : [];
  const first = runs[0] as GithubJson | undefined;
  const id = first?.['id'];
  return typeof id === 'number' ? id : null;
}

/**
 * Write (or re-write) the link check on one commit.
 *
 * ⚠️ It is UPSERT-BY-NAME, not create: an existing run at the same SHA is PATCHed,
 * so linking a pull request turns the SAME check green rather than adding a
 * second, contradictory one below the first. That is the card's *"it must CLEAR
 * when the link arrives"* criterion, and the reason this is not two functions.
 */
export async function writeCheckRun(spec: CheckRunSpec): Promise<CheckRunWriteOutcome> {
  let token: string;
  // ⚠️ THE APP IS CHOSEN BY THE REPOSITORY'S PROVENANCE (MOTIR-5861). A hosted
  // repository is installed on the provisioning App ONLY, so minting through the
  // user-facing default throws GithubAppNotConfiguredError — which the catch below
  // turns into `'unavailable'`, documented as "nothing is wrong". The consequence
  // is not cosmetic: `Motir / work item link` had never been written on a hosted
  // repository at all, so an unlinked pull request there carried no red check and
  // the one mechanism that catches the costliest omission a run can make was
  // silently absent on Motir's own project repositories.
  const role = githubAppRoleForRepo({ owner: spec.owner }, await motirOwnedOrgLogins());
  try {
    ({ token } = await mintInstallationToken(spec.installationId, role));
  } catch {
    // Unconfigured App, unmintable token, unreachable host — all the same answer
    // to the caller, which is "no check was written and nothing is wrong".
    return 'unavailable';
  }

  const base = repoUrl(spec.owner, spec.name);
  // Same guard as the reads, and applied even though the scanner did not flag this
  // site: an inconsistent whitelist is the shape the note above describes.
  if (base === null || !COMMIT_SHA.test(spec.headSha)) return 'unavailable';

  const existingId = await findExistingRun(token, spec.owner, spec.name, spec.headSha);
  const payload = {
    name: LINK_CHECK_NAME,
    head_sha: spec.headSha,
    status: 'completed',
    conclusion: spec.conclusion,
    output: { title: spec.title, summary: spec.summary },
  };

  let res: Response;
  try {
    res = await githubFetch(
      'checkRuns.write',
      existingId === null ? `${base}/check-runs` : `${base}/check-runs/${existingId}`,
      {
        method: existingId === null ? 'POST' : 'PATCH',
        headers: headers(token),
        body: JSON.stringify(payload),
      },
    );
  } catch {
    return 'unavailable';
  }

  if (res.status === 403) return 'not_permitted';
  if (!res.ok) return 'unavailable';
  return existingId === null ? 'created' : 'updated';
}

/**
 * The head SHA of a pull request, read from the host.
 *
 * ⚠️ WHY THIS EXISTS AND WHY IT IS NOT A COLUMN. A check run is addressed by
 * commit, and only ONE of the two callers has one: a `pull_request` delivery
 * carries `pull_request.head.sha`, while `link_pull_request` is a call about a
 * pull request the caller may have opened seconds earlier and knows only by
 * number. `docs/decisions/unlinked-pull-request-check.md` proposed stamping a
 * `head_sha` column from every delivery and falling back to a read; the column is
 * NOT added, because a schema change on the shared development database is a cost
 * every parallel session pays (a migration it did not write shows up as drift in
 * its own `migrate diff`), and this read is one call on a path that is already
 * doing network I/O. The ADR is amended in the same pull request rather than left
 * describing a design that was not built.
 *
 * `pull_requests: write` covers the read, so it needs no new permission.
 */
export async function readPullRequestHeadSha(
  installationId: string,
  owner: string,
  name: string,
  number: number,
): Promise<string | null> {
  let token: string;
  // Provenance, as `writeCheckRun` (MOTIR-5861). This read feeds the link check,
  // so on a hosted repository it returned `null` for the same reason the check was
  // never written — and `null` here is indistinguishable from a pull request the
  // host does not have.
  const role = githubAppRoleForRepo({ owner }, await motirOwnedOrgLogins());
  try {
    ({ token } = await mintInstallationToken(installationId, role));
  } catch {
    return null;
  }
  const base = repoUrl(owner, name);
  const url = base === null ? null : pullUrl(base, number);
  if (url === null) return null;
  let res: Response;
  try {
    res = await githubFetch('checkRuns.pullRequestHead', url, {
      headers: headers(token),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: GithubJson | null;
  try {
    body = (await res.json()) as GithubJson;
  } catch {
    return null;
  }
  const head = body?.['head'];
  const sha = typeof head === 'object' && head !== null ? (head as GithubJson)['sha'] : null;
  return typeof sha === 'string' && sha.length > 0 ? sha : null;
}

// ── READING THE COMMIT'S WHOLE CHECK SET (MOTIR-4199) ───────────────────────
//
// Everything above WRITES a check; this reads them, and it exists because every
// verdict Motir forms about a commit was a fold over *the rows we had recorded*.
// Nothing in that path knew how many checks a commit HAS, so "no pending row"
// was read as "nothing pending" — and GitHub delivers check runs one webhook at
// a time, so a recorded set that is a PREFIX of the real one is the ordinary
// state of every pull request for the first minutes of its life. A commit with
// five jobs whose first three successes landed before the other two were
// recorded produced `✅ all 3 checks succeeded — verified` and promoted the card
// to In Review with the suite still running.
//
// The provider is the only party that knows the answer, so this asks it. What it
// establishes is a FACT ("these are the check runs GitHub holds for this
// commit"), not an inference from an absence.
//
// ⚠️ WHAT IT DOES NOT ANSWER, stated because the caller must not read more into
// it than it says: it is a snapshot of the runs GitHub has CREATED. A workflow
// that has not started at all — a `workflow_dispatch` nobody fired, a job queued
// after the call — is in no snapshot, and no read of the provider can be. It
// narrows the window from "however many webhooks have been processed" to
// "however many runs the host has created", which is the whole of the
// improvement and the whole of the limit.
//
// `checks: read` covers it — the same permission `findExistingRun` above uses —
// so it needs no new consent from any installation.

/** One check run as the host reports it, in the normalized vocabulary the
 *  webhook parser produces, so a row written from here is indistinguishable from
 *  the row that delivery would have written. */
export interface ReportedCheckRun {
  checkName: string;
  /** The run it belongs to (`check_suite.id`), as `github_check_run` stores it —
   *  `''` is never produced here, since every REST check run names its suite. */
  checkSuiteId: string;
  conclusion: CiConclusion;
  /** The host's RAW conclusion, verbatim — `null` while the run is not `completed`.
   *  `conclusion` above folds `cancelled` / `timed_out` into `failure`; a merge-queue
   *  exit is judged by which one it was (§4 SIXTH AMENDMENT, MOTIR-6846). */
  rawConclusion: string | null;
  /** The run's own page, and when it completed — what a merge-queue attempt records
   *  about its failing check (MOTIR-6848). */
  url: string | null;
  completedAt: Date | null;
  /** A suite's OWN roll-up row rather than a check (MOTIR-6274) — set only by
   *  `readCommitActionsSuites`, never by the check-run read. Omitted = a check. */
  suiteAggregate?: boolean;
}

function completedAtOf(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** At most this many check runs are read for one commit. motir-core's own
 *  pull requests carry ~34; the cap exists so a pathological commit cannot turn
 *  one verdict into an unbounded number of round trips. Exceeding it returns
 *  `null` — "the set could not be established" — rather than a truncated set,
 *  because a truncated set is exactly the defect this module exists to remove. */
const MAX_CHECK_RUNS = 500;
const PER_PAGE = 100;

/**
 * Every check run GitHub holds for one commit, or `null` when the set could not
 * be established (the App is unconfigured, the token cannot be minted, the host
 * is unreachable or refuses, the payload does not parse, or the commit carries
 * more checks than the cap).
 *
 * ⚠️ `null` IS NOT "no checks" — it is "no answer". A commit with no check runs
 * at all returns an EMPTY ARRAY. Callers must read the two differently: an empty
 * array says the host has nothing recorded for this commit, a `null` says ask
 * again later and meanwhile fall back to whatever was already known.
 */
export async function readCommitCheckRuns(
  installationId: string,
  owner: string,
  name: string,
  headSha: string,
): Promise<ReportedCheckRun[] | null> {
  let token: string;
  // Provenance, as above (MOTIR-5861). `null` means "no answer", not "no checks"
  // — its own header says so — so on a hosted repository the reconcile worker was
  // told to ask again for ever, which it duly did.
  const role = githubAppRoleForRepo({ owner }, await motirOwnedOrgLogins());
  try {
    ({ token } = await mintInstallationToken(installationId, role));
  } catch {
    return null;
  }

  const base = repoUrl(owner, name);
  if (base === null || !COMMIT_SHA.test(headSha)) return null;

  const collected: ReportedCheckRun[] = [];
  // `filter=latest` is GitHub's own answer to "which run of a re-run counts",
  // and it is deliberately NOT used: which recorded run still gets a vote is
  // `liveCheckRows`' single decision (MOTIR-3209), and a host-side filter here
  // would be a second one. `filter=all` gives the rows; the existing rule judges
  // them.
  for (let page = 1; page * PER_PAGE <= MAX_CHECK_RUNS + PER_PAGE; page++) {
    let res: Response;
    try {
      res = await githubFetch(
        'checkRuns.read',
        `${base}/commits/${headSha}/check-runs?filter=all&per_page=${PER_PAGE}&page=${page}`,
        { headers: headers(token) },
      );
    } catch {
      return null;
    }
    if (!res.ok) return null;

    let body: GithubJson | null;
    try {
      body = (await res.json()) as GithubJson;
    } catch {
      return null;
    }

    const totalCount = body?.['total_count'];
    if (typeof totalCount !== 'number') return null;
    if (totalCount > MAX_CHECK_RUNS) return null;

    const runs = Array.isArray(body?.['check_runs']) ? (body['check_runs'] as unknown[]) : [];
    for (const raw of runs) {
      const run = raw as GithubJson | null;
      if (!run || typeof run !== 'object') continue;
      const checkName = run['name'];
      if (typeof checkName !== 'string' || checkName.length === 0) continue;
      const suite = run['check_suite'];
      const suiteId =
        typeof suite === 'object' && suite !== null ? (suite as GithubJson)['id'] : undefined;
      const status = typeof run['status'] === 'string' ? run['status'] : null;
      const conclusion = typeof run['conclusion'] === 'string' ? run['conclusion'] : null;
      collected.push({
        checkName,
        checkSuiteId:
          typeof suiteId === 'number' || typeof suiteId === 'string' ? String(suiteId) : '',
        // The SAME rule the `check_run` webhook parser applies: anything not
        // `completed` is `pending`, whatever conclusion the payload carries.
        conclusion:
          status !== 'completed' ? 'pending' : mapGithubCiConclusion(conclusion ?? 'neutral'),
        rawConclusion: status === 'completed' ? conclusion : null,
        url: typeof run['html_url'] === 'string' ? run['html_url'] : null,
        completedAt: completedAtOf(run['completed_at']),
      });
    }

    if (collected.length >= totalCount || runs.length === 0) break;
  }

  return collected;
}

// ── READING THE COMMIT'S ACTIONS WORKFLOW RUNS (MOTIR-6946) ─────────────────
//
// The check-run read above cannot see a workflow run that GitHub has CREATED but
// that has not created a job yet — and that state is not rare. motir-core's
// `ci.yml` carries a workflow-level `concurrency` group, so every push to an open
// pull request queues the new CI run behind the cancellation of the previous
// head's run; on moooon-B-V/motir-core#3261 @ `688ce704` the CI run existed for
// 86 s with ZERO check runs, the acceptance lane settled green inside that gap,
// and the recorded set's claim to be whole was confirmed by a host read that
// could not see the missing workflow. The approve-to-merge question was raised
// over commits whose test suite had not started.
//
// GitHub DID know: the run's check SUITE exists from the moment the run is
// created. So this reads the commit's check suites and reports every GitHub
// Actions one as a suite roll-up row — the SAME row a `check_suite` delivery
// records (`checkName` = the App slug, the suite id, `suiteAggregate`), so a
// row written from here is indistinguishable from the delivery that settles it
// and the ordinary `check_suite` `completed` webhook upserts it terminal.
//
// ⚠️ ONLY THE `github-actions` APP, deliberately. Third-party Apps (Vercel,
// Sentry, Claude on the very commit above) create a suite on every push and
// leave it `queued` for ever with no runs; counting them would hold every card.
// An Actions suite exists only for a workflow that TRIGGERED — motir-core has
// ~20 workflows and that commit carried three Actions suites — so a suite here
// is a workflow run that will report.
//
// ⚠️ AND WHY NOT `GET /actions/runs?head_sha=`, which names the workflow. The
// user-facing App (`motir-integration`) holds `checks: read` and NOT
// `actions: read` (`docs/decisions/unlinked-pull-request-check.md`), so that
// read is refused on exactly the repositories this defect was seen on — and a
// refusal here degrades to "no answer", which would have made the fix inert
// while every test that stubs the read stayed green. `checks: read` covers
// `/commits/{sha}/check-suites`.

/** The App slug GitHub Actions reports its check suites under. */
export const ACTIONS_APP_SLUG = 'github-actions';

/** Every GitHub Actions check suite GitHub holds for one commit, as suite
 *  roll-up rows — or `null` when the set could not be established (the same
 *  `null`-is-not-empty contract as `readCommitCheckRuns`). A suite that is not
 *  `completed` is `pending`, whatever conclusion the payload carries: the rule
 *  the `check_suite` webhook parser applies. */
export async function readCommitActionsSuites(
  installationId: string,
  owner: string,
  name: string,
  headSha: string,
): Promise<ReportedCheckRun[] | null> {
  let token: string;
  const role = githubAppRoleForRepo({ owner }, await motirOwnedOrgLogins());
  try {
    ({ token } = await mintInstallationToken(installationId, role));
  } catch {
    return null;
  }

  const base = repoUrl(owner, name);
  if (base === null || !COMMIT_SHA.test(headSha)) return null;

  let res: Response;
  try {
    // One page: a commit carries one suite per triggered workflow run plus one per
    // App — a handful, never a hundred. More than one page is "no answer", like
    // the check-run cap, rather than a truncated set.
    res = await githubFetch(
      'checkRuns.read',
      `${base}/commits/${headSha}/check-suites?per_page=${PER_PAGE}`,
      {
        headers: headers(token),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: GithubJson | null;
  try {
    body = (await res.json()) as GithubJson;
  } catch {
    return null;
  }
  const totalCount = body?.['total_count'];
  if (typeof totalCount !== 'number' || totalCount > PER_PAGE) return null;

  const suites = Array.isArray(body?.['check_suites']) ? (body['check_suites'] as unknown[]) : [];
  const rows: ReportedCheckRun[] = [];
  for (const raw of suites) {
    const suite = raw as GithubJson | null;
    if (!suite || typeof suite !== 'object') continue;
    const app = suite['app'];
    const slug = typeof app === 'object' && app !== null ? (app as GithubJson)['slug'] : null;
    if (slug !== ACTIONS_APP_SLUG) continue;
    const id = suite['id'];
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    const status = typeof suite['status'] === 'string' ? suite['status'] : null;
    const conclusion = typeof suite['conclusion'] === 'string' ? suite['conclusion'] : null;
    rows.push({
      checkName: ACTIONS_APP_SLUG,
      checkSuiteId: String(id),
      conclusion:
        status !== 'completed' ? 'pending' : mapGithubCiConclusion(conclusion ?? 'neutral'),
      // A roll-up is never a merge-queue exit's failing CHECK, which is what the
      // raw conclusion is read for (`pickFailingCheck` skips a null one).
      rawConclusion: null,
      url: null,
      // A finished suite's `updated_at`, the same clock the `check_suite` webhook
      // dates its roll-up by. The lost-completion settle writes it onto the row, and
      // the attempt rule needs a GREEN roll-up's time to retire an earlier attempt's
      // failures under it (MOTIR-11827); without one the green orders nothing.
      completedAt: status === 'completed' ? completedAtOf(suite['updated_at']) : null,
      suiteAggregate: true,
    });
  }
  return rows;
}
