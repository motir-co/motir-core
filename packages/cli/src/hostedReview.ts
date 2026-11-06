import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentReviewBug,
  AgentReviewVerdict,
  ReviewPrompt,
  ReviewPullRequest,
} from './client.js';
import type { LinkConfig } from './config/linkConfig.js';
import {
  materializeDispatchCheckouts,
  renderMaterialization,
  resolveDispatchTargets,
} from './dispatch.js';
import type { CommandRunner } from './git.js';

// THE HOSTED REVIEW's pure half (Story MOTIR-1626 · MOTIR-6824; `hosted-agent-run.md`
// §8.2–§8.5) — what `motir review` checks out, what it tells the agent on top of the
// served prompt, and how it reads the agent's ONE verdict back. The command
// (`commands/review.ts`) sequences these; nothing here talks to Motir.
//
// ── THE VERDICT CONTRACT (the file, not the route) ───────────────────────────
// The served prompt (`lib/dispatch/reviewPromptTemplate.ts`) gives the verdict's SHAPE
// — `subjectVersion`, `verdict`, `summaryMd`, `findingsMd` — as the body of
// `POST …/agent-review`. The agent cannot make that call: its environment is
// allow-listed without the run credential (`hostedAgent.ts`). So the CLI tells it to
// write that SAME body, as one JSON object, to a file outside every checkout, and the
// CLI submits it — once. The file is held to the route's own rules, strictly: those
// four keys plus the optional `bugs` list (MOTIR-10513 — the defects the verdict cannot
// carry, which the server files: the agent has no other way to log one), the verdict one of the two, findings required and non-empty on
// `changes_requested`, the route's length bounds, and `subjectVersion` — when the agent
// writes one — EXACTLY the version the CLI checked out. Anything else is NO verdict:
// nothing is posted, and the run ends failed (the server writes the review as one that
// could not run, `approval-gates.md` §12.6).

/** The env var naming the verdict file, beside the path in the prompt itself. */
export const REVIEW_VERDICT_FILE_ENV = 'MOTIR_REVIEW_VERDICT_FILE';
/** The version the server booted the review for (MOTIR-6820), when it says. */
export const REVIEW_VERSION_ENV = 'MOTIR_REVIEW_VERSION';
/** The gate the server booted the review for (MOTIR-6820), when it says. */
export const REVIEW_GATE_ENV = 'MOTIR_REVIEW_GATE_ID';

/** The route's bounds (`lib/dispatch/reviewPromptTemplate.ts`), mirrored — the route re-checks. */
export const REVIEW_SUMMARY_MAX_LENGTH = 500;
export const REVIEW_FINDINGS_MAX_LENGTH = 65_536;
/** The bugs a verdict may log (MOTIR-10513), and each one's bounds. */
export const REVIEW_BUGS_MAX = 5;
export const REVIEW_BUG_TITLE_MAX_LENGTH = 200;
export const REVIEW_BUG_DESCRIPTION_MAX_LENGTH = 20_000;

const VERDICT_KEYS = new Set(['subjectVersion', 'verdict', 'summaryMd', 'findingsMd', 'bugs']);
const BUG_KEYS = new Set(['title', 'descriptionMd']);

/** The verdict's optional `bugs` list, held to the route's rules — or why it is not. */
function parseBugs(value: unknown): AgentReviewBug[] | Error {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return new Error('`bugs` must be a list');
  if (value.length > REVIEW_BUGS_MAX) {
    return new Error(`\`bugs\` holds more than ${REVIEW_BUGS_MAX} entries`);
  }
  const bugs: AgentReviewBug[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `\`bugs[${index}]\``;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return new Error(`${at} is not one JSON object`);
    }
    const bug = entry as Record<string, unknown>;
    const extra = Object.keys(bug).filter((k) => !BUG_KEYS.has(k));
    if (extra.length > 0) return new Error(`${at} has unknown key(s): ${extra.join(', ')}`);
    const field = (name: 'title' | 'descriptionMd', max: number): string | Error => {
      const raw = bug[name];
      if (typeof raw !== 'string' || !raw.trim()) {
        return new Error(`${at}.${name} is required and must not be empty`);
      }
      const trimmed = raw.trim();
      if (trimmed.length > max) return new Error(`${at}.${name} is longer than ${max} characters`);
      return trimmed;
    };
    const title = field('title', REVIEW_BUG_TITLE_MAX_LENGTH);
    if (title instanceof Error) return title;
    const descriptionMd = field('descriptionMd', REVIEW_BUG_DESCRIPTION_MAX_LENGTH);
    if (descriptionMd instanceof Error) return descriptionMd;
    bugs.push({ title, descriptionMd });
  }
  return bugs;
}

export type VerdictRead = { ok: true; verdict: AgentReviewVerdict } | { ok: false; reason: string };

/**
 * Parse the agent's verdict file. TOTAL: every way it can be wrong is a reason, never
 * a throw and never a guess.
 */
export function parseReviewVerdict(raw: string, subjectVersion: string): VerdictRead {
  const no = (reason: string): VerdictRead => ({ ok: false, reason });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return no('the verdict file is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return no('the verdict file is not one JSON object');
  }
  const body = parsed as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !VERDICT_KEYS.has(k));
  if (extra.length > 0) return no(`the verdict has unknown key(s): ${extra.join(', ')}`);

  const verdict = body.verdict;
  if (verdict !== 'pass' && verdict !== 'changes_requested') {
    return no('`verdict` must be "pass" or "changes_requested"');
  }
  if (body.subjectVersion !== undefined && body.subjectVersion !== subjectVersion) {
    return no('`subjectVersion` is not the version this review checked out');
  }
  const text = (name: 'summaryMd' | 'findingsMd', max: number): string | null | Error => {
    const value = body[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return new Error(`\`${name}\` must be a string`);
    if (value.length > max) return new Error(`\`${name}\` is longer than ${max} characters`);
    return value.trim() ? value : null;
  };
  const summaryMd = text('summaryMd', REVIEW_SUMMARY_MAX_LENGTH);
  if (summaryMd instanceof Error) return no(summaryMd.message);
  const findingsMd = text('findingsMd', REVIEW_FINDINGS_MAX_LENGTH);
  if (findingsMd instanceof Error) return no(findingsMd.message);
  if (verdict === 'changes_requested' && findingsMd === null) {
    return no('`findingsMd` is required, and must not be empty, on `changes_requested`');
  }
  const bugs = parseBugs(body.bugs);
  if (bugs instanceof Error) return no(bugs.message);
  return {
    ok: true,
    verdict: {
      subjectVersion,
      verdict,
      summaryMd: summaryMd === null ? null : summaryMd.trim(),
      findingsMd,
      bugs,
    },
  };
}

/** Read and parse the verdict file; a missing or unreadable one is no verdict. */
export function readReviewVerdict(path: string, subjectVersion: string): VerdictRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'the agent wrote no verdict file' };
  }
  if (!raw.trim()) return { ok: false, reason: 'the verdict file is empty' };
  return parseReviewVerdict(raw, subjectVersion);
}

// ── The checkouts ─────────────────────────────────────────────────────────

/** One pull request, checked out DETACHED at its reviewed head. */
export interface ReviewCheckout {
  repository: string;
  number: number;
  headSha: string;
  path: string;
}

type PreparedReview =
  | { ok: true; checkouts: ReviewCheckout[]; materialized: string[] }
  | { ok: false; message: string };

/** `owner/name` → `name`, the checkout's directory under the workspace. */
function repoName(repository: string): string {
  return repository.slice(repository.lastIndexOf('/') + 1);
}

/**
 * CHECK OUT every pull request of the delivery set at its REVIEWED head, detached
 * (§8.2–§8.3). Each repository is cloned through `motir run`'s own materializer
 * (`materializeDispatchCheckouts`) as `<root>/<name>`; each head is fetched when the
 * clone does not already hold it — by its sha, else by `refs/pull/<n>/head` — and
 * checked out DETACHED, so no branch exists that a push could name. A second pull
 * request in the same repository gets its own detached worktree beside it.
 *
 * ⚠️ NOTHING HERE WRITES TO A REMOTE: clone, fetch, checkout, worktree — no push, no
 * branch creation. A head that cannot be reached, or a checkout that does not land ON
 * it, refuses the review before any agent starts.
 */
export function prepareReviewCheckouts(input: {
  key: string;
  pullRequests: readonly ReviewPullRequest[];
  rootDir: string;
  config: LinkConfig;
  run: CommandRunner;
  exists: (path: string) => boolean;
}): PreparedReview {
  if (input.pullRequests.length === 0) {
    return { ok: false, message: `${input.key}: the review names no pull request to review.` };
  }
  const repositories = [...new Set(input.pullRequests.map((pr) => pr.repository))];
  const targets = resolveDispatchTargets(
    input.rootDir,
    input.config,
    repositories.map((repository) => ({
      name: repoName(repository),
      cloneUrl: `https://github.com/${repository}.git`,
    })),
    { exists: input.exists },
  );
  const materialized = materializeDispatchCheckouts(input.rootDir, targets, { run: input.run });
  const lines = renderMaterialization(materialized);
  if (materialized.failures.length > 0) {
    return {
      ok: false,
      message: [`${input.key}: a repository under review could not be cloned.`, ...lines].join(
        '\n',
      ),
    };
  }

  const fail = (pr: ReviewPullRequest, what: string, detail = ''): PreparedReview => ({
    ok: false,
    message:
      `${input.key}: ${pr.repository} #${pr.number} — ${what}` +
      `${detail.trim() ? ` (${detail.trim()})` : ''}. No agent was started.`,
  });
  const used = new Set<string>();
  const checkouts: ReviewCheckout[] = [];
  for (const pr of input.pullRequests) {
    const repoPath = targets[repositories.indexOf(pr.repository)]!.repoPath as string;
    const git = (args: string[], cwd = repoPath) => input.run('git', args, cwd);
    const has = () => git(['cat-file', '-e', `${pr.headSha}^{commit}`]).exitCode === 0;
    if (!has()) {
      const bySha = git(['fetch', '--quiet', 'origin', pr.headSha]);
      if (bySha.exitCode !== 0 || !has()) {
        git([
          'fetch',
          '--quiet',
          'origin',
          `+refs/pull/${pr.number}/head:refs/remotes/origin/motir-review/${pr.number}`,
        ]);
      }
      if (!has()) return fail(pr, `its reviewed head ${pr.headSha} could not be fetched`);
    }
    // The base, so `git diff origin/<base>...<head>` — the served prompt's own line —
    // answers. Best effort: the clone already holds the default branch.
    if (pr.baseBranch) {
      git([
        'fetch',
        '--quiet',
        'origin',
        `+refs/heads/${pr.baseBranch}:refs/remotes/origin/${pr.baseBranch}`,
      ]);
    }
    const second = used.has(repoPath);
    const path = second ? `${repoPath}-pr-${pr.number}` : repoPath;
    const placed = second
      ? git(['worktree', 'add', '--detach', path, pr.headSha])
      : git(['checkout', '--quiet', '--detach', pr.headSha]);
    if (placed.exitCode !== 0) {
      return fail(pr, `could not check out ${pr.headSha} at ${path}`, placed.stderr);
    }
    const head = git(['rev-parse', 'HEAD'], path);
    if (head.exitCode !== 0 || head.stdout.trim() !== pr.headSha) {
      return fail(pr, `${path} is at ${head.stdout.trim() || 'nothing'}, not ${pr.headSha}`);
    }
    used.add(repoPath);
    checkouts.push({ repository: pr.repository, number: pr.number, headSha: pr.headSha, path });
  }
  return { ok: true, checkouts, materialized: lines };
}

/** The written standards a checkout carries — `CLAUDE.md` / `AGENTS.md`, only when present (§8.5). */
export function checkoutStandards(
  checkouts: readonly ReviewCheckout[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  const found: string[] = [];
  for (const path of new Set(checkouts.map((c) => c.path))) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      if (exists(join(path, name))) found.push(join(path, name));
    }
  }
  return found;
}

// ── What the agent is told on top of the served prompt ───────────────────────

/**
 * The HOSTED section the CLI appends to the served review prompt: where the code is,
 * the repository standards that exist, and the verdict FILE — the one channel out.
 */
export function reviewRunSection(input: {
  served: Pick<ReviewPrompt, 'subjectVersion'>;
  checkouts: readonly ReviewCheckout[];
  verdictFile: string;
  standards: readonly string[];
}): string {
  const lines = [
    '',
    '## HOSTED REVIEW RUN — where the code is, and how your verdict leaves',
    '',
    'Every pull request above is ALREADY checked out, detached at its reviewed head:',
    '',
    ...input.checkouts.map(
      (c) => `  - ${c.repository} #${c.number} at ${c.headSha}\n      ${c.path}`,
    ),
    '',
  ];
  if (input.standards.length > 0) {
    lines.push(
      'These repositories carry their own written standard. Read it as a standard for',
      'the CHANGED code — quote the rule a finding relies on; where the card requires',
      'what it forbids, the card wins:',
      '',
      ...input.standards.map((path) => `  - ${path}`),
      '',
    );
  }
  lines.push(
    'Pushing is disabled in this run and `gh` is unavailable: you cannot commit, push or',
    'post anything, and must not try.',
    '',
    '⚠️ YOUR VERDICT IS A FILE, NOT A REQUEST. You hold no credential for the verdict',
    'route, so do NOT call it. Write the verdict body described under YOUR VERDICT —',
    'one JSON object and nothing else — to:',
    '',
    `  ${input.verdictFile}`,
    `  (also in $${REVIEW_VERDICT_FILE_ENV})`,
    '',
    'Motir submits it, exactly once, after you exit. These keys and no others:',
    '',
    `  "subjectVersion"  EXACTLY "${input.served.subjectVersion}"`,
    '  "verdict"         "pass" or "changes_requested"',
    `  "summaryMd"       at most ${REVIEW_SUMMARY_MAX_LENGTH} characters: what you concluded`,
    '  "findingsMd"      Markdown findings — REQUIRED and non-empty on "changes_requested"',
    `  "bugs"            OPTIONAL — at most ${REVIEW_BUGS_MAX} { "title", "descriptionMd" } objects, the`,
    '                    defects the verdict cannot carry (A DEFECT THE VERDICT CANNOT',
    '                    CARRY, above). Motir files them with the verdict; you cannot',
    '                    file a bug any other way. Leave the key out when there is none.',
    '',
    'A missing, unparseable or incomplete file, or any other key, is NO verdict: the',
    'review is recorded as one that could not run. Write the file LAST, once you are sure.',
  );
  return `${lines.join('\n')}\n`;
}
