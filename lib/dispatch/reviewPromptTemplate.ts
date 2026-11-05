import { splitPlanBody } from '@/lib/markdown/planBody';

// THE REVIEW PROMPT (Story MOTIR-1626 · MOTIR-6821; ADR `docs/decisions/hosted-agent-run.md`
// §8.2–§8.4, `approval-gates.md` §12.3–§12.5) — the brief a hosted REVIEW run is handed.
//
// ⚠️ PURE, like `assembleDispatchPrompt` beside it: a function of its inputs and nothing
// else, so the same gate always yields the same text and the sections a later card adds
// (MOTIR-6904's coding conventions) JOIN the inputs rather than reading anything here.
// `agentReviewRunService.getReviewPrompt` is the half that touches state.
//
// What it says, and why:
//   · THE CARD — both bodies, the acceptance criteria under their own heading, and the
//     published How to test. The reviewer judges the change against what was ASKED, so
//     the card is the brief, not a summary of it.
//   · THE CODE — every pull request of the delivery set at the REVIEWED head, the one the
//     gate's `subjectVersion` names, never a head read later (§8.2). A two-repository card
//     is ONE review over both.
//   · THE LIMITS — read-only: push nothing, post nothing to GitHub (§8.3).
//   · THE ANSWER — ONE verdict, in an exact shape, through the verdict route (§8.4).
//
//   · THE CONVENTIONS (MOTIR-6904, §8.5) — per delivery-set repository, Motir's derived
//     coding convention when there is one, capped; else one line saying that repository is
//     reviewed against the card only. The list is resolved by
//     `reviewConventionsService.resolveReviewConventions`; this file only renders it.
//
// ⚠️ IT NAMES NO CONVENTION FILE UNCONDITIONALLY. A repository's own `CLAUDE.md` /
// `AGENTS.md` is mentioned only as "if the checkout has one" (§8.5: never required), so a
// reviewer is never sent after a file most repositories lack, and a missing one is never a
// finding.

/** The verdicts a review may give (§8.4). */
export const REVIEW_VERDICTS = ['pass', 'changes_requested'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** The summary's bound — a line or two a person reads on the card. */
export const REVIEW_SUMMARY_MAX_LENGTH = 500;
/**
 * The findings' bound. `ApprovalGate.noteMd` is unbounded `text`, so this is the verdict
 * route's own ceiling — generous for a review of any real change, and small enough that a
 * runaway agent cannot write megabytes onto a gate row every surface renders.
 */
export const REVIEW_FINDINGS_MAX_LENGTH = 65_536;

/**
 * The per-repository cap on a convention's text in the prompt (§8.5: "capped to a bounded
 * size … so one repository's long convention cannot crowd out the card"). Characters, not
 * bytes. A longer convention is cut at the last line boundary within the cap and followed by
 * {@link CONVENTION_SHORTENED_LINE}; the full text is on Code Health (`/code`).
 */
export const REVIEW_CONVENTION_MAX_CHARS = 12_000;

/** The line that follows a convention cut at {@link REVIEW_CONVENTION_MAX_CHARS}. */
export const CONVENTION_SHORTENED_LINE =
  '[This convention was shortened to fit the review. The full text is on Code Health, /code.]';

/** The line an `absent` repository gets — no convention, motir-ai unconfigured or unreachable. */
export const CONVENTION_ABSENT_LINE =
  'No coding convention is recorded for this repository. Review it against the card only.';

/**
 * One delivery-set repository's coding convention, as resolved for the prompt (§8.5).
 * `absent` covers all three absent cases — none recorded, motir-ai not configured, motir-ai
 * erroring or timing out — and the prompt does not tell them apart: each is reviewed against
 * the card alone, and none is a review that could not run.
 */
export type ReviewConventionForPrompt =
  | { repoKey: string; state: 'present'; version: number; contentMd: string }
  | { repoKey: string; state: 'absent' };

/**
 * Cap a convention's text at {@link REVIEW_CONVENTION_MAX_CHARS}: text at or under the cap is
 * returned whole; longer text is cut at the last line boundary within the cap (a single
 * over-long first line is cut at the cap itself) and followed by the shortened line.
 */
export function capConvention(contentMd: string): { text: string; shortened: boolean } {
  const text = contentMd.trimEnd();
  if (text.length <= REVIEW_CONVENTION_MAX_CHARS) return { text, shortened: false };
  const head = text.slice(0, REVIEW_CONVENTION_MAX_CHARS + 1);
  const lastBreak = head.lastIndexOf('\n');
  const cut = lastBreak > 0 ? head.slice(0, lastBreak) : head.slice(0, REVIEW_CONVENTION_MAX_CHARS);
  return { text: `${cut.trimEnd()}\n${CONVENTION_SHORTENED_LINE}`, shortened: true };
}

/** One pull request of the delivery set, at the head the review is about. */
export interface ReviewPullRequestForPrompt {
  /** `owner/name`. */
  repository: string;
  number: number;
  /** The REVIEWED head — from the gate's `subjectVersion`, never a later read. */
  headSha: string;
  /** The pull request's base branch, when Motir knows it. */
  baseBranch: string | null;
  /** Its head branch, when Motir knows it. */
  headBranch: string | null;
  title: string | null;
  url: string;
}

/**
 * One card's criteria in the CRITERIA CHECKLIST (Story MOTIR-10327 · MOTIR-10336) — the run
 * target first, then every descendant in tree order. `state` says how to read the card:
 * `open` is still to be delivered, `done` delivered already (its criteria still count, the
 * run target's acceptance can rest on them), `skipped` cancelled or archived.
 */
export interface ReviewCriteriaGroupForPrompt {
  key: string;
  title: string;
  state: 'open' | 'done' | 'skipped';
  /** The card's acceptance-criteria lines, as `splitPlanBody` reads them. */
  criteria: readonly string[];
}

export interface ReviewPromptInput {
  key: string;
  title: string;
  projectName: string;
  descriptionMd: string | null;
  explanationMd: string | null;
  /** The CURRENT How to test's body, or null when none is published. */
  howToTestMd: string | null;
  /** The gate's `subjectVersion` — echoed into the verdict so a late one is detectable. */
  subjectVersion: string;
  /** The delivery set at the reviewed head, in the set's canonical order. */
  pullRequests: readonly ReviewPullRequestForPrompt[];
  /**
   * The CODING CONVENTION of each distinct delivery-set repository (MOTIR-6904, §8.5), in
   * the delivery set's order — `present` with its capped text, or `absent`. Omitted or
   * empty ⇒ no CODING CONVENTIONS section at all.
   */
  conventions?: readonly ReviewConventionForPrompt[];
  /**
   * The run target and every descendant, in tree order, each with its criteria
   * (MOTIR-10336). The first group is the run target. Omitted, or the run target alone ⇒
   * the single-card ACCEPTANCE CRITERIA listing, exactly as before.
   */
  criteriaTree?: readonly ReviewCriteriaGroupForPrompt[];
}

export interface AssembledReviewPrompt {
  prompt: string;
}

const RULE = '─'.repeat(72);

function section(title: string, lines: readonly string[]): string[] {
  return ['', title, '', ...lines];
}

function indent(md: string): string[] {
  return md.split('\n').map((line) => (line.length > 0 ? `  ${line}` : ''));
}

function pullRequestLines(pr: ReviewPullRequestForPrompt): string[] {
  const base = pr.baseBranch ?? '<its base branch>';
  return [
    `  - ${pr.repository} #${pr.number}${pr.title ? ` — ${pr.title}` : ''}`,
    `      ${pr.url}`,
    `      reviewed head: ${pr.headSha}`,
    `      base: ${base}${pr.headBranch ? ` · branch: ${pr.headBranch}` : ''}`,
    `      the change:    git fetch origin ${base} ${pr.headSha} && git diff origin/${base}...${pr.headSha}`,
  ];
}

function conventionEntryLines(entry: ReviewConventionForPrompt): string[] {
  if (entry.state === 'absent') {
    return ['', `  ${entry.repoKey}`, `    ${CONVENTION_ABSENT_LINE}`];
  }
  const { text } = capConvention(entry.contentMd);
  return [
    '',
    `  ${entry.repoKey} — Motir's coding convention, version ${entry.version}`,
    '',
    ...text.split('\n').map((line) => (line.length > 0 ? `    ${line}` : '')),
  ];
}

function conventionSectionLines(conventions: readonly ReviewConventionForPrompt[]): string[] {
  if (conventions.length === 0) return [];
  return section('CODING CONVENTIONS', [
    '  How code is written in each repository, as Motir has derived it. How to use them:',
    '  - Treat each convention below as a standard for the code the pull request CHANGES.',
    '    A finding that relies on one QUOTES the rule it breaks.',
    '  - Where the card’s acceptance criteria explicitly require something a convention',
    '    forbids, the card wins: say so in your summary rather than sending it back.',
    '  - Code the pull request did not touch is never a finding.',
    '  - If a repository’s checkout has a CLAUDE.md or AGENTS.md at its root, read it as',
    '    the same kind of standard. If it has neither, that is not a finding and is not',
    '    mentioned.',
    '  - A missing convention is never a reason to return `changes_requested`.',
    ...conventions.flatMap(conventionEntryLines),
  ]);
}

const GROUP_STATE_NOTE: Record<ReviewCriteriaGroupForPrompt['state'], string> = {
  open: '',
  done: ' (done — its criteria still count)',
  skipped: ' (skipped — cancelled or archived; not reviewed)',
};

function criteriaGroupLines(group: ReviewCriteriaGroupForPrompt, index: number): string[] {
  const head = `  ${group.key} — ${group.title}${index === 0 ? ' (the run target)' : ''}${GROUP_STATE_NOTE[group.state]}`;
  if (group.state === 'skipped') return ['', head];
  return [
    '',
    head,
    ...(group.criteria.length > 0
      ? group.criteria.map((line) => `    ${line}`)
      : [
          '    (This card names no acceptance criteria. That is a checklist row of its own and',
          '    a finding — never a pass.)',
        ]),
  ];
}

/** The criteria part: the whole tree's checklist, or the run target's own listing. */
function criteriaSectionLines(
  ownCriteria: readonly string[],
  tree: readonly ReviewCriteriaGroupForPrompt[] | undefined,
): string[] {
  if (!tree || tree.length <= 1) {
    return section(
      'ACCEPTANCE CRITERIA',
      ownCriteria.length > 0
        ? ownCriteria.map((line) => `  ${line}`)
        : ['  (The card names none. Review against its description and How to test.)'],
    );
  }
  return section('CRITERIA CHECKLIST — this card and every card under it', [
    '  The run target’s acceptance rests on what the cards under it delivered, so every',
    '  card’s criteria are checked here, grouped by card, the run target first.',
    ...tree.flatMap(criteriaGroupLines),
  ]);
}

/**
 * Assemble the review prompt. Deterministic: the same input gives byte-identical text.
 */
export function assembleReviewPrompt(input: ReviewPromptInput): AssembledReviewPrompt {
  const { body, acceptanceCriteria } = splitPlanBody(input.descriptionMd);
  const multi = input.pullRequests.length > 1;

  const lines: string[] = [
    `You are REVIEWING the delivered code of ${input.key} — "${input.title}" (${input.projectName}).`,
    '',
    'Motir asks you one question: is this code right for THIS card? Judge the change against',
    'what the card asked for — its description, its acceptance criteria and its How to test —',
    'not against what you would have built. You decide it alone, and your verdict is recorded',
    'as the review agent’s, before any person is asked to approve the merge.',
    RULE,
    ...section('THE CARD', [
      `  ${input.key} — ${input.title}`,
      '',
      ...(body ? indent(body) : ['  (The card has no description.)']),
    ]),
    ...criteriaSectionLines(acceptanceCriteria, input.criteriaTree),
    ...section(
      'WHY IT MATTERS (the card’s explanation)',
      input.explanationMd?.trim() ? indent(input.explanationMd.trim()) : ['  (None written.)'],
    ),
    ...section(
      'HOW TO TEST (as published for this card)',
      input.howToTestMd?.trim()
        ? indent(input.howToTestMd.trim())
        : ['  (None is published yet. Do not treat its absence as a finding.)'],
    ),
    ...section(
      multi
        ? `THE CODE — ${input.pullRequests.length} pull requests, ONE review over all of them`
        : 'THE CODE — one pull request',
      [
        '  Review each pull request at its REVIEWED head below — never a later commit. If the',
        '  branch has moved on, that is not yours to review: review the head named here.',
        '',
        ...input.pullRequests.flatMap(pullRequestLines),
      ],
    ),
    ...conventionSectionLines(input.conventions ?? []),
    ...section('HOW TO REVIEW', [
      '  - Read the whole diff of every pull request above, and enough of the surrounding',
      '    code to judge it.',
      '  - Check it against EACH acceptance criterion: is it met, and is it tested?',
      '  - Write ONE checklist row per criterion, each `met`, `not met` or `cannot tell`.',
      '    A `met` row QUOTES its evidence: the file and line, or the test that pins it.',
      '    A `met` without evidence is not allowed: write that row as `cannot tell`.',
      '  - A card that names no criteria is a checklist row of its own, and a finding.',
      '  - Rank every finding blocker, major, minor or nit.',
      '  - Look for defects the change introduces: wrong behaviour, a missed case the card',
      '    names, broken error handling, a security hole, a regression in code it touches.',
      '  - Report what must change for the card to be right. Style preferences that no',
      '    criterion or written standard asks for are not findings.',
      '  - If a finding relies on a written standard, QUOTE the rule it breaks.',
    ]),
    ...section('YOU ARE READ-ONLY', [
      '  - Push NOTHING. Do not commit, amend, rebase or push to any branch.',
      '  - Post NOTHING to GitHub — no review, no comment, no check, no label.',
      '  - Change no status and write nothing else in Motir. Your verdict is your only output.',
    ]),
    ...section('YOUR VERDICT — submit exactly ONE', [
      `  POST /api/v1/work-items/${input.key}/agent-review`,
      '',
      '  {',
      `    "subjectVersion": "${input.subjectVersion}",`,
      '    "verdict": "pass" | "changes_requested",',
      `    "summaryMd": "<at most ${REVIEW_SUMMARY_MAX_LENGTH} characters: what you concluded>",`,
      '    "findingsMd": "<Markdown findings>"',
      '  }',
      '',
      '  - `subjectVersion` is EXACTLY the string above: the version you reviewed.',
      `  - ONE verdict, for ${input.key} — the run target — only. Cards under it are sources`,
      '    of criteria, never verdict targets: never submit a verdict for one of them.',
      '  - `changes_requested` — any checklist row is `not met`, or any finding is a blocker',
      '    or major. `findingsMd` is REQUIRED then: one finding per item, each naming the',
      '    FILE and LINE, the criterion (or quoted rule) it breaks, and WHAT TO CHANGE.',
      '    Minor findings and nits never send the card back.',
      '  - A `cannot tell` row alone does not send the card back: name it in `summaryMd`.',
      '  - `pass` — otherwise. `findingsMd` then holds the checklist and minor notes only.',
      '  - Put the checklist at the TOP of `findingsMd`, on either verdict, as a Markdown',
      '    table — | criterion | status | evidence | — ahead of the findings.',
      '  - One verdict per review. A second is refused. If the code moved while you were',
      '    reviewing, your verdict is recorded and decides nothing — that is expected.',
    ]),
  ];

  return { prompt: `${lines.join('\n')}\n` };
}
