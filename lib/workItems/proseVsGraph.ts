// PROSE-vs-GRAPH reference extraction (MOTIR-1969) — the pure half of the
// advisory that warns when a card's BODY names a not-done work item it carries
// no `blocked_by` edge to.
//
// ⚠️ This is an ADDITION beside the finishability rules, NOT an extension of
// them. `gatingItemSatisfied` (lib/workItems/validity.ts) is a pure
// EDGE-AND-STATUS walk — it never reads a description. This pass asks a
// different question entirely: compare the set a body NAMES against the set the
// graph has EDGES to. Do not try to route it through `gatingItemSatisfied`; the
// two share no input.
//
// ⚠️ KNOWN BLIND SPOT — a `type: decision` card's deferrals are invisible here
// (`notes.html` #202, found by MOTIR-1980). This check's ONLY input is
// `descriptionMd`. A decision card's deliverable is a DOCUMENT in a repository
// (e.g. `docs/decisions/ci-runner-fleet.md` §11), and every deferral it writes
// lives there — outside the graph and outside every plan-side validator. The
// card's own body never names what the document deferred, so the named set N is
// EMPTY for exactly the reference that mattered. Covering that gap needs repo
// access and is a much larger surface; it is deliberately NOT this module's job.
// The covering mechanism is a planner RULE (MOTIR-1975 W3 — a deferral must be
// mirrored onto the target card's acceptance criteria in the same pass), not
// code here. Documentation only; no behaviour follows from it.
//
// Pure string work — no Prisma, no IO — so it is unit-testable in isolation.
// The service half (resolving the named ids, dropping done / exempt targets)
// lives in `lib/services/proseGraphAdvisoryService.ts`.

import { WORKITEM_TOKEN_RE, INTRA_PLAN_REF_TOKEN_RE } from '@/lib/mentions/workItemRefs';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { isTypeableKind } from '@/lib/issues/executorDefaults';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import type { IssueType } from '@/lib/issues/parentRules';
import { parseSections } from '@/lib/workItems/sections/parse';
import type { SectionType } from '@/lib/workItems/sections/registry';

/**
 * How strongly a body reference suggests a MISSING `blocked_by` edge. Two tiers,
 * ONE advisory channel — NEITHER is a blocker (see the module note in
 * `proseGraphAdvisoryService`).
 *
 * - `advisory` — the not-done item is named ANYWHERE in the body. A reference
 *   may or may not be a dependency: out-of-scope sections, "the owner of the
 *   other half is X", context refs, superseded-by notes, sibling record cards.
 * - `likely-missing-edge` — the not-done item is named inside the card's own
 *   ACCEPTANCE-CRITERIA section. An AC is what the card is CLOSED AGAINST, so
 *   naming a not-done card there is consuming it by definition (MOTIR-2012
 *   item 2; the canonical fixture is MOTIR-2011, two of whose five ACs named
 *   MOTIR-2007's unmerged deliverables against a `relates_to`-only edge).
 */
export type ProseAdvisorySeverity = 'advisory' | 'likely-missing-edge';

/** Rank for "the card reports the HIGHEST tier" across a reference's occurrences. */
const SEVERITY_RANK: Record<ProseAdvisorySeverity, number> = {
  advisory: 0,
  'likely-missing-edge': 1,
};

/**
 * The heading that opens a card's acceptance-criteria section — any level, the
 * words optionally preceded by heading markup only. Deliberately a HEURISTIC
 * (see {@link acceptanceCriteriaSpan}); it is a refinement of the advisory,
 * never a precondition for emitting one.
 */
const AC_HEADING_RE = /^#{1,6}\s*acceptance criteria/i;

/** Any ATX heading line — group 1 is the `#` run, so its LEVEL is its length. */
const HEADING_LINE_RE = /^(#{1,6})\s/;

/**
 * The character span of a body's ACCEPTANCE-CRITERIA section: from the heading
 * matching {@link AC_HEADING_RE} to the next heading of the SAME or HIGHER level
 * (a deeper sub-heading stays inside the section), or to the end of the body.
 *
 * ⚠️ The section boundary is a HEURISTIC, so what happens when it fails is
 * specified rather than left to chance: a card with NO such heading — or with
 * its acceptance criteria inline in prose — returns `null`, which is **not an
 * error and not a silent miss**. Every reference in that card then falls back to
 * the plain `advisory` tier. The heuristic DEGRADES; it never suppresses.
 */
export function acceptanceCriteriaSpan(md: string): { start: number; end: number } | null {
  const lines = md.split('\n');
  // Byte offset of the start of each line, so a match maps back to a span.
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1; // +1 for the '\n' consumed by the split
  }

  let start: number | null = null;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (start === null) {
      if (!AC_HEADING_RE.test(line)) continue;
      start = offsets[i] as number;
      level = (HEADING_LINE_RE.exec(line)?.[1] as string | undefined)?.length ?? 1;
      continue;
    }
    const heading = HEADING_LINE_RE.exec(line);
    if (heading && (heading[1] as string).length <= level) {
      return { start, end: offsets[i] as number };
    }
  }
  return start === null ? null : { start, end: md.length };
}

/**
 * The work items a body NAMES — the set **N** of the prose-vs-graph rule — each
 * mapped to the HIGHEST severity any of its occurrences earns.
 *
 * Two token forms are extracted, and the returned key is what the caller
 * resolves the reference against:
 *  - `[LABEL](motir:<id>)` → the bare work-item id (the shipped chip form every
 *    card in this family carries — which is exactly why this is a REGEX over
 *    `descriptionMd` and not a text-understanding problem);
 *  - `[LABEL](motir-ref:planItem:<id>)` → `planItem:<id>`, the SAME temp-ref the
 *    plan projection keys a not-yet-materialized `add` by, so a projected body
 *    can name a projected sibling.
 *
 * Real-corpus behaviour, all deliberate:
 *  - **Multiple links to the same id are deduped** — one entry, highest tier.
 *  - **A malformed / unknown id simply doesn't match, or resolves to nothing.**
 *    It is body text, never an error (the same contract `parseWorkItemTokenIds`
 *    has always had).
 *  - **A token inside a code fence or blockquote IS extracted.** This module
 *    deliberately uses the SAME extraction as the shipped auto-relate write path
 *    (`autoRelateWorkItemMentions`), because auto-relate is what wrote the
 *    `relates_to` edge this advisory contrasts against `blocked_by`. Using a
 *    narrower N here would make the advisory disagree with the graph it is
 *    auditing. An advisory is non-blocking, so the cost of including an
 *    illustrative reference is a line of output, never a stalled card.
 */
export function bodyReferenceSeverities(
  md: string | null | undefined,
): Map<string, ProseAdvisorySeverity> {
  const out = new Map<string, ProseAdvisorySeverity>();
  if (!md) return out;

  const note = (id: string, severity: ProseAdvisorySeverity): void => {
    const prev = out.get(id);
    if (prev === undefined || SEVERITY_RANK[severity] > SEVERITY_RANK[prev]) out.set(id, severity);
  };

  const scan = (text: string, severity: ProseAdvisorySeverity): void => {
    for (const m of text.matchAll(WORKITEM_TOKEN_RE)) note(m[1] as string, severity);
    for (const m of text.matchAll(INTRA_PLAN_REF_TOKEN_RE)) {
      note(`${TEMP_REF_PREFIX}${m[2] as string}`, severity);
    }
  };

  // Whole body first (every reference earns at least `advisory`), then the AC
  // section promotes the ones inside it — so the tiers are computed
  // per-occurrence and each reference reports the highest.
  scan(md, 'advisory');
  const span = acceptanceCriteriaSpan(md);
  if (span) scan(md.slice(span.start, span.end), 'likely-missing-edge');
  return out;
}

const BLOCKER_COUNT_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  both: 2,
};

const BLOCKER_COUNT_TOKEN_RE =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|both|\d+)\b/gi;
const OWN_BLOCKERS_RE = /\bsiblings\s+(?:this\s+card|it)\s+is\s+blocked_by\b/i;

export interface BlockerCountClaim {
  claim: string;
  claimedCount: number;
}

/**
 * The first explicit cardinality claim a card makes about its own blocker set.
 *
 * This is intentionally the grammar measured for MOTIR-5428, not a general
 * prose interpretation: an explicit count must occur within eight words of the
 * plural `siblings this card is blocked_by` / `siblings it is blocked_by`
 * anchor. Quoted lines are records or examples, and singular `sibling` phrases
 * are not set-cardinality claims, so neither is consumed.
 */
export function firstBlockerCountClaim(md: string | null | undefined): BlockerCountClaim | null {
  if (!md) return null;

  for (const rawLine of md.split('\n')) {
    if (/["“”]/.test(rawLine)) continue;
    const line = rawLine.replace(INLINE_MARKUP_RE, '');
    const anchor = OWN_BLOCKERS_RE.exec(line);
    if (!anchor || anchor.index === undefined) continue;

    const prefix = line.slice(0, anchor.index);
    const counts = [...prefix.matchAll(BLOCKER_COUNT_TOKEN_RE)];
    const count = counts.at(-1);
    if (!count || count.index === undefined) continue;
    if (/MOTIR-$/i.test(prefix.slice(0, count.index))) continue;

    const between = prefix.slice(count.index + count[0].length);
    if ((between.match(/\b[\p{L}\p{N}_-]+\b/gu) ?? []).length > 8) continue;

    const token = count[0].toLowerCase();
    const claimedCount = /^\d+$/.test(token) ? Number(token) : BLOCKER_COUNT_WORDS[token];
    if (claimedCount === undefined || !Number.isSafeInteger(claimedCount)) continue;

    let start = count.index;
    const before = prefix.slice(0, start);
    const all = /\ball\s*$/i.exec(before);
    if (all?.index !== undefined) start = all.index;
    return {
      claim: line
        .slice(start, anchor.index + anchor[0].length)
        .replace(/\s+/g, ' ')
        .trim(),
      claimedCount,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ORDERING CHECK (MOTIR-2175) — gate 14's third axis, mechanized.
//
// A different question from everything above: not "does this body name a card
// the graph has no edge to", but "does this body ask for state that cannot
// exist yet". It shares only the AC span with the reference scan, which is why
// it lives in the same module and not in a new one.
//
// A card's own boundary ends at **PR opened** — `Project.prMergeMode` is
// `manual`, `motir run` stops at the PR, and the merge is Yue's. (That premise
// holds until something merges on the setting's say-so: Story MOTIR-4882, the
// merge gate, is what changes it.) So an
// acceptance criterion whose truth requires the merge belongs to a DIFFERENT
// card, and gate 14's remedy is to cut the card at that line. The 1-based index
// of the offending criterion is therefore the actionable half of the finding:
// it names where the cut goes.
//
// ⚠️ THIS IS A PARTIAL TELL, NOT THE CHECK — AND IT IS NOT TO BE WIDENED
// (MOTIR-5426). The list below was once gate 14's own test, verbatim. The rule
// has since replaced it with a QUESTION — *does the criterion name a moment that
// can only arrive once THIS work item's diff is on the default branch?* — and
// calls the phrases "examples of a yes rather than the test" (`motir-meta`
// `prompts/plan-rules/core.md`, gate 14(c)). So the list here is a fixed set of
// merge-word examples, and its silence is not a verdict.
//
// MEASURED over the `done` corpus (MOTIR-5426, 2026-09-23): of ~121 post-deploy
// criteria on non-exempt cards (stratified sample of 246 cards + a random 160),
// these phrases match ~13 — about ONE IN NINE — and of the times they fire, one
// to two in three land on a criterion that is not post-deploy. The misses name
// an OBSERVATION, not a merge: "against real runs", "its number is quoted
// here", "the next scheduled run is green", "curl app.motir.co after deploy".
//
// A WIDER predicate was measured too, and it does not rescue this. A deploy-
// surface pattern (production / live / deploy / release / a host / `origin/main`
// / a platform) reached 8 of 10 post-deploy criteria at 20% precision; a
// "moment-after" pattern, 5 of 10 at 33%. Their false positives are the most
// CAREFUL cards — the ones that name the post-deploy moment in order to DISCLAIM
// it ("no criterion here asserts anything about production", "the post-deploy
// card that confirms …"). A lexical test cannot tell a criterion that READS the
// moment from one that DEFERS it; the class test is a relation between the
// criterion and this card's own diff, and it needs a reader. So: do not add a
// seventh phrase, and do not swap in a regex. The empty advisory is the
// documented blind spot; gate 14(c)'s question is the check.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fixed set of MERGE-WORD examples of gate 14's ORDERING axis. A criterion
 * carrying any of them very likely reads on state that exists only after the
 * card's own PR has merged — but a criterion carrying NONE of them is not
 * cleared (see the block above: the set reaches about one post-deploy criterion
 * in nine).
 *
 * `the published` is the rule's former `the published <X>` entry — the phrase is
 * the prefix; what follows it is the artifact and varies per card.
 *
 * ⚠️ NOT pinned to the rule's prose any more (MOTIR-5426 retired that guard
 * deliberately): the rule stopped being a list, and the pin had already been
 * guarding a sentence the rule no longer contains. `tests/workItems/
 * proseVsGraph.test.ts` pins this set BY VALUE instead, and pins the measured
 * blind spot beside it.
 */
export const POST_MERGE_CRITERION_PHRASES = [
  'merged to main',
  'once this lands',
  'once it lands',
  'after release',
  'on main',
  'the published',
] as const;

/** One phrase, as a whitespace-tolerant, word-bounded matcher. */
const POST_MERGE_PHRASE_MATCHERS: ReadonlyArray<{ phrase: string; re: RegExp }> =
  POST_MERGE_CRITERION_PHRASES.map((phrase) => ({
    phrase,
    // `\s+` between words so a criterion that wraps a line still matches; `\b`
    // at both ends so `on main` does not fire inside `companion maintainer`.
    re: new RegExp(`\\b${phrase.split(' ').join('\\s+')}\\b`, 'i'),
  }));

/** A criterion line: a top-level `-`/`*`/`+` or `1.`/`1)` bullet, unindented. */
const CRITERION_BULLET_RE = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * Inline markup a phrase can be wearing. Gate 14's own prose writes "merged to
 * `main`" and MOTIR-2162 wrote "**once it lands**", so a matcher that reads the
 * raw Markdown finds neither. Backticks and emphasis runs are stripped before
 * matching; nothing else is touched (underscores stay, so identifiers survive).
 */
const INLINE_MARKUP_RE = /[`*]/g;

/** The ORDERING finding: which phrase, and which criterion carries it. */
export interface PostMergeCriterion {
  /** The matched phrase in its canonical {@link POST_MERGE_CRITERION_PHRASES} form. */
  phrase: string;
  /** 1-based index of the offending criterion within the acceptance-criteria list. */
  criterionIndex: number;
}

/**
 * The FIRST acceptance criterion carrying one of the
 * {@link POST_MERGE_CRITERION_PHRASES}, or `null`. `null` means no merge-word was
 * found — NOT that no criterion reads on post-merge state (MOTIR-5426).
 *
 * Scope is the **acceptance-criteria span only** — {@link acceptanceCriteriaSpan}
 * — and its degrade-never-suppress contract applies here unchanged, with one
 * inversion worth stating out loud: for the reference scan, no AC heading means
 * every reference falls back to the plain `advisory` tier; here it means
 * **nothing is emitted at all**. That is deliberate rather than a shortcut. The
 * phrases are perfectly legitimate in a body's narrative — a card's own
 * explanation may say "once this lands, the next card can start" — and are a
 * DEFECT only in a criterion, which is the thing the card is closed against. A
 * body-wide scan would fire on most well-written cards in this corpus.
 *
 * Only ENUMERATED criteria count. A bullet (or `1.` item) at column zero opens a
 * criterion; everything after it — continuation lines, indented sub-bullets —
 * belongs to that criterion, so a phrase in a wrapped line is attributed to the
 * bullet it wraps from. Prose inside the AC section that is not under any bullet
 * is not a criterion and is not scanned; there is no index to report for it.
 *
 * Returns the FIRST offender because gate 14's remedy needs exactly one number:
 * *"EVERY criterion at or below the first line carrying one belongs to a
 * different card"* — so the first index IS the cut line, and the ones below it
 * are consequences rather than separate findings.
 */
export function firstPostMergeCriterion(md: string | null | undefined): PostMergeCriterion | null {
  if (!md) return null;
  const span = acceptanceCriteriaSpan(md);
  if (!span) return null;

  let criterionIndex = 0;
  for (const raw of md.slice(span.start, span.end).split('\n')) {
    if (CRITERION_BULLET_RE.test(raw)) criterionIndex += 1;
    // Before the first bullet: the heading itself and any lead-in prose.
    if (criterionIndex === 0) continue;
    const text = raw.replace(INLINE_MARKUP_RE, '');
    for (const { phrase, re } of POST_MERGE_PHRASE_MATCHERS) {
      if (re.test(text)) return { phrase, criterionIndex };
    }
  }
  return null;
}

/**
 * Whether a card is EXEMPT from the ordering check — `type: 'deploy'` or
 * `executor: 'human'`.
 *
 * ⚠️ This is the rule's own remedy read back as a predicate, NOT a noise filter
 * and NOT a threshold. Gate 14 says post-merge criteria belong on a `deploy` /
 * `human` card — the release trio's *cut* leg, which is DEFINED by needing the
 * merge — so such a card carrying such a phrase is the shape the rule wants and
 * the phrase in it is correct. Suppressing there costs no coverage at all,
 * while a false positive on it would train readers to skip the advisory
 * channel, which is how the check that DID fire unaided (`likely-missing-edge`)
 * gets ignored.
 */
export function isOrderingCheckExempt(
  type: string | null | undefined,
  executor: string | null | undefined,
): boolean {
  return type === 'deploy' || executor === 'human';
}

// ─────────────────────────────────────────────────────────────────────────────
// THE POST-MERGE CHILD CHECK (MOTIR-8863) — a runnable container is ONE
// deliverable that ends at its pull request.
//
// A child whose own body says it can only start once the deployment exists
// (`verification` / `deploy` / `manual` / human work that reads production) has no
// legal position INSIDE the container whose merge it waits on: the parent run's
// pull request stays a draft until the last child lands so it never merges,
// `CONTAINER_HAS_OPEN_CHILDREN` refuses the container's flip to `implemented`,
// and a forced merge cascades `done` onto the child unperformed. The remedy is
// placement — a sibling the container `blocks`, or a second container.
//
// The rule existed in both planners as prose and was missed seven times
// (MOTIR-3270 · 7498 · 7870 · 8559 · 8589 · 8634 · 8863); this makes the miss
// visible at `validate_work_item` / `validate_plan`, where it can be repaired
// before an approval.
//
// ⚠️ UNLIKE gate 14's ordering check this scans the WHOLE body, not the AC span:
// MOTIR-8860 stated its tell in the Context ("Earliest legal start: after the
// deploy …"), not in a criterion. The scope that keeps that affordable is the
// CHILD's type/executor — a `code` card is never asked — and the container's kind
// (an epic's children are SIBLINGS of a story, which is where the remedy puts it).
// ─────────────────────────────────────────────────────────────────────────────

/** Phrases that read the deployment, matched whitespace- and markup-tolerantly. */
export const POST_MERGE_CHILD_PHRASES = [
  'earliest legal start',
  'after the deploy',
  'after the deployment',
  'once deployed',
  'once the deploy',
  'post-deploy',
  'on production',
  'in production',
  'against production',
  'live tenant',
  'merged to main',
  'once this lands',
  'once it lands',
  'after release',
] as const;

/**
 * Tells a body uses once it already TAKES the merge or the deployment as given,
 * rather than naming the moment it waits for (MOTIR-10057). All five post-deploy
 * cards MOTIR-9710's lay put inside the story slipped past the phrase list:
 * "the cards listed in the blockers have merged", "starts from the deployed
 * state", "deployed to the rehearsal services". The bare "is deployed" is left
 * out on purpose ("nothing is deployed by this card" is pre-merge): a false
 * positive here opens a plan.py repair session (MOTIR-9991).
 */
const POST_MERGE_CHILD_STATE_TELLS: ReadonlyArray<{ phrase: string; re: RegExp }> = [
  { phrase: 'have merged', re: /\b(?:has|have)\s+(?:been\s+)?merged\b/i },
  { phrase: 'the deployed', re: /\bthe\s+deployed\b/i },
  { phrase: 'deployed to', re: /\bdeployed\s+to\b/i },
];

const POST_MERGE_CHILD_MATCHERS: ReadonlyArray<{ phrase: string; re: RegExp }> = [
  ...POST_MERGE_CHILD_PHRASES.map((phrase) => ({
    phrase,
    re: new RegExp(`\\b${phrase.split(' ').join('\\s+')}\\b`, 'i'),
  })),
  ...POST_MERGE_CHILD_STATE_TELLS,
];

/** Container kinds whose children may legitimately wait on a SIBLING's merge. */
export function isPostMergeChildCheckExemptContainer(
  containerKind: string | null | undefined,
): boolean {
  return containerKind == null || containerKind === 'epic';
}

/** Whether a card of this type/executor is the kind that waits on a deployment. */
export function isPostMergeChildCandidate(
  type: string | null | undefined,
  executor: string | null | undefined,
): boolean {
  return type === 'verification' || type === 'deploy' || type === 'manual' || executor === 'human';
}

/** The first deployment-reading phrase anywhere in a body, or `null`. */
export function firstPostMergeChildTell(md: string | null | undefined): string | null {
  if (!md) return null;
  const text = md.replace(INLINE_MARKUP_RE, '');
  for (const { phrase, re } of POST_MERGE_CHILD_MATCHERS) {
    if (re.test(text)) return phrase;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REPO-STRADDLE CHECK (MOTIR-2177) — gate 1's criterion-by-criterion repo
// column, mechanized as far as it mechanizes and NO FURTHER.
//
// A CONTRADICTION, not a count. The naive form — count the distinct repos named
// across the criteria, warn at two — fires on nearly every card in this corpus,
// because motir-core submitting a job that EXECUTES in motir-ai is the
// architecture, and gate 1's own text says so. So the question asked here is
// narrower and answerable from facts the card already asserts: an acceptance
// criterion names a repo-qualified path whose owning repo is NOT the card's
// `targetRepo`. ONE SUBTASK = ONE REPO = ONE PR, so a criterion discharged
// outside the pin is unsatisfiable inside it — wrong regardless of how the
// reference was meant.
//
// ⚠️ TWO FORMS OF THE TELL THIS CHECK CANNOT SEE. Neither is an oversight, and a
// reader who assumes `likely-repo-straddle` retires gate 1's prose will lose
// coverage rather than gain it:
//
//   1. **The BARE SYMBOL.** MOTIR-1983's entire self-declaration was
//      `SHARED_PLANNING_RULES` inside a parenthetical — a symbol whose repo a
//      reader happens to know. Mapping a symbol to a repo needs a cross-repo
//      index this check does not have and is not getting. Gate 1's prose remains
//      the ONLY cover for that form.
//   2. **A BOUNDARY-CONTRACT card** — a producer plus its mirrored consumer, two
//      coordinated PRs, legitimately one card — WILL fire here. That is an
//      ACCEPTED false positive, not a bug: the advisory never blocks, the shape
//      is rare, and one line of output is the whole cost. It is also why this is
//      the FIRST check to withdraw if advisory fatigue shows — its precision is
//      lower than the ordering check's, and the prose still covers its family.
//
// ⚠️ ONE SHAPE IT USED TO MISREAD, NOW DECLINED (MOTIR-6288): **a top-level
// DIRECTORY that shares a repository's name.** `motir-gateway` keeps its
// Motir-specific code under `motir/`, and the domain also holds a repository
// named `motir`, so the bare-name form attributed every `motir/catalog/…`
// criterion on a gateway card to the other repo — a false `contradiction` on
// most of that repo's surface. The contradiction arm now declines a path that
// resolved by its BARE first segment when that segment is the NAME-NAMESPACE of
// a repo the card carries (a carried repo is named `<segment>-…`, `<segment>_…`
// or `<segment>.…`) — see {@link isCarriedNamespaceDirectory}. A narrowing, not
// a guess: it needs no tree, only the card's own set. The residual blind spot
// it buys is a bare `motir/…` path that really IS in the `motir` repo on a card
// carrying `motir-*`; writing it `owner/motir/…` is unambiguous and still fires.
// The `unpinnable` arm is untouched — with no set there is no namespace to read.
//
// Deliberately NO exemption predicate (contrast {@link isOrderingCheckExempt}).
// The ordering check's exemption is the RULE'S OWN REMEDY read back — a `deploy`
// / `human` card is DEFINED by needing the merge. Gate 1 has no such shape;
// suppressing the boundary-contract card would need a signal the plan does not
// carry, and guessing at one would cost real coverage to buy tidiness.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One repo the check can resolve a path prefix against — the structural subset
 * of `ConnectedRepoName` (`lib/workItems/targetRepo.ts`) this module needs.
 *
 * Declared here rather than imported so the module stays pure and unit-testable
 * with a literal; `ConnectedRepoName` is structurally assignable to it, so the
 * service passes the workspace's connected set straight through.
 */
export interface RepoCandidate {
  /** The bare repo NAME — the value `work_item.targetRepo` stores. */
  name: string;
  /** `owner/name`, the form the GitHub surfaces display. */
  repoRef: string;
}

/**
 * A path-like token: two or more `/`-separated segments. Matched against text
 * with {@link INLINE_MARKUP_RE} already stripped, because the corpus writes
 * paths in backticks (`` `motir-ai/src/foo.ts` ``).
 */
const PATH_TOKEN_RE = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g;

/** {@link PATH_TOKEN_RE} without `g`, for a `test()` that must not carry state. */
const PATH_TOKEN_PRESENT_RE = new RegExp(PATH_TOKEN_RE.source);

/**
 * The repo a path-like token belongs to, or `null` when it belongs to none of
 * `candidates`.
 *
 * Both prefix forms `targetRepo` itself accepts (`normalizeTargetRepo`) are
 * resolved, `owner/name` first so an owner that happens to share a repo's name
 * cannot shadow it:
 *  - `moooon-B-V/motir-core/lib/x.ts` → the `owner/name` form, matched against
 *    {@link RepoCandidate.repoRef};
 *  - `motir-core/lib/x.ts` → the bare-name form, matched against
 *    {@link RepoCandidate.name}.
 *
 * Case-insensitive (git-host repo names are), and the returned value is the
 * CANDIDATE's own casing, so a finding and the `targetRepo` column can never
 * disagree on spelling.
 *
 * **A token that resolves to nothing is BODY TEXT and yields `null`** — no
 * error, no finding. `packages/cli/build.ts`, `docs/decisions/x.md` and
 * `https://ghcr.io/token` are all just prose here, which is what keeps the check
 * a reading of the repo registry rather than a guess about what a slash means.
 *
 * A token with NO slash is likewise `null` even when it exactly names a repo: a
 * bare name is the SYMBOL form this check does not cover (see the module note),
 * and treating it as a path would fire on every card that merely says
 * "motir-ai".
 */
export function resolvePathRepo(
  token: string,
  candidates: readonly RepoCandidate[],
): string | null {
  return resolvePathRepoForm(token, candidates)?.name ?? null;
}

/**
 * {@link resolvePathRepo}, plus WHICH prefix form matched — the straddle arm
 * needs to know, because only the bare-name form can collide with a directory.
 */
function resolvePathRepoForm(
  token: string,
  candidates: readonly RepoCandidate[],
): { name: string; form: 'owner' | 'bare' } | null {
  const segments = token.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const ownerName = `${segments[0]}/${segments[1]}`.toLowerCase();
  const byRef = candidates.find((c) => c.repoRef.toLowerCase() === ownerName);
  if (byRef) return { name: byRef.name, form: 'owner' };
  const bare = (segments[0] as string).toLowerCase();
  const byName = candidates.find((c) => c.name.toLowerCase() === bare);
  return byName ? { name: byName.name, form: 'bare' } : null;
}

/**
 * Whether a resolved path is more plausibly a top-level DIRECTORY of a carried
 * repo than a path in the repo it resolved to (MOTIR-6288).
 *
 * True only when the path resolved by the BARE-name form AND that name is the
 * name-namespace of a carried repo: `motir/catalog/x.go` on a card carrying
 * `motir-gateway`. A sibling that merely shares a namespace (`motir-ai` beside
 * `motir-core`) is NOT one — neither name is the other's prefix — so the
 * straddle this check exists for still fires.
 */
export function isCarriedNamespaceDirectory(
  path: string,
  carried: ReadonlySet<string>,
  candidates: readonly RepoCandidate[],
): boolean {
  const resolved = resolvePathRepoForm(path, candidates);
  if (!resolved || resolved.form !== 'bare') return false;
  const ns = resolved.name.toLowerCase();
  for (const repo of carried) {
    if (
      repo.length > ns.length &&
      repo.startsWith(ns) &&
      '-_.'.includes(repo[ns.length] as string)
    ) {
      return true;
    }
  }
  return false;
}

/** A resolvable repo-qualified path, and which criterion wrote it. */
export interface CriterionRepoPath {
  /** The path token as the criterion wrote it (markup stripped). */
  path: string;
  /** The repo it resolves to, in the candidate's own casing. */
  repo: string;
  /** 1-based index of the criterion within the acceptance-criteria list. */
  criterionIndex: number;
}

/**
 * Whether a body's acceptance criteria contain ANY path-like token at all.
 *
 * Pure, candidate-free, and cheap — its only job is to let the service skip the
 * connected-repositories read for the common card that names no path. It is
 * deliberately over-inclusive (it cannot know which prefixes resolve); a `true`
 * here means "worth resolving", never "there is a finding".
 */
export function hasCriterionPathTokens(md: string | null | undefined): boolean {
  if (!md) return false;
  const span = acceptanceCriteriaSpan(md);
  if (!span) return false;
  for (const raw of md.slice(span.start, span.end).split('\n')) {
    if (PATH_TOKEN_PRESENT_RE.test(raw.replace(INLINE_MARKUP_RE, ''))) return true;
  }
  return false;
}

/**
 * Every repo-qualified path in the acceptance-criteria span, in document order,
 * each attributed to the criterion that carries it.
 *
 * Scope and attribution are {@link firstPostMergeCriterion}'s exactly — the AC
 * span only, enumerated criteria only, a continuation line belonging to the
 * bullet it wraps from — so the two shape checks report the same criterion
 * numbering and a card carrying both findings can be cut against one index.
 * Unresolvable tokens are dropped as they are met.
 */
export function criterionRepoPaths(
  md: string | null | undefined,
  candidates: readonly RepoCandidate[],
): CriterionRepoPath[] {
  if (!md || candidates.length === 0) return [];
  const span = acceptanceCriteriaSpan(md);
  if (!span) return [];

  const found: CriterionRepoPath[] = [];
  let criterionIndex = 0;
  for (const raw of md.slice(span.start, span.end).split('\n')) {
    if (CRITERION_BULLET_RE.test(raw)) criterionIndex += 1;
    if (criterionIndex === 0) continue; // the heading and any lead-in prose
    for (const m of raw.replace(INLINE_MARKUP_RE, '').matchAll(PATH_TOKEN_RE)) {
      // A path ending a sentence arrives with its full stop — strip it the way
      // {@link bodyFilePaths} does, or the finding reports `x.ts.` (MOTIR-6321).
      const path = m[0].replace(TRAILING_DOTS_RE, '');
      const repo = resolvePathRepo(path, candidates);
      if (repo !== null) found.push({ path, repo, criterionIndex });
    }
  }
  return found;
}

/**
 * Why a straddle finding was emitted — the two arms are different questions and
 * a reader must not have to infer which one fired.
 *
 * - `contradiction` — the card CARRIES a repository set and a criterion is
 *   discharged in a repo the set does not contain. The card contradicts itself;
 *   the set and the criterion are both things the card asserts.
 * - `unpinnable` — the card carries NO repository and its criteria name two or
 *   more distinct repos. Gate 1's *"`targetRepo: null` on a card whose
 *   deliverables you can ENUMERATE is not 'not yet pinned' — check whether it is
 *   UNPINNABLE"*, which is the same finding wearing a friendlier face.
 */
export type RepoStraddleReason = 'contradiction' | 'unpinnable';

/** The REPO-STRADDLE finding: which path, whose repo, which criterion, why. */
export interface RepoStraddleCriterion extends CriterionRepoPath {
  reason: RepoStraddleReason;
}

/**
 * The FIRST acceptance criterion that straddles a repo boundary, or `null`.
 *
 * **Card carrying repositories — the CONTRADICTION arm.** The first resolvable
 * path whose repo is not in the card's SET. A criterion naming a path in ANY
 * repository the card carries is the normal case and never fires, however many
 * times it does so.
 *
 * ⚠️ **Widened from a single pin to the SET (Story MOTIR-2725 · MOTIR-2728).**
 * This check encodes ONE SUBTASK = ONE REPO, and that rule is untouched — what
 * changed is that a work item can now legitimately CARRY more than one
 * repository, so "the repo this card ships in" is a set membership test rather
 * than an equality. **Not deleted, and not softened:** a card naming a repository
 * it does NOT carry is still exactly the defect this was built to find, and a
 * two-element set does not excuse a path in a third repo.
 *
 * A bare-name path whose first segment is the namespace of a carried repo is
 * DECLINED rather than reported ({@link isCarriedNamespaceDirectory},
 * MOTIR-6288): it names that repo's own top-level directory as often as it
 * names the other repo, and the `owner/name` form stays available for the
 * genuine cross-repo reference.
 *
 * **Card carrying nothing — the UNPINNABLE arm.** With nothing to
 * contradict, one repo across the criteria is a card that simply has not been
 * pinned yet, and nothing is emitted. TWO OR MORE distinct repos is the finding:
 * the reported path is the first occurrence of the SECOND repo — the point at
 * which the split becomes visible, which is the same cut-line semantics
 * {@link firstPostMergeCriterion} reports and the same place a human building
 * gate 1's repo column would stop.
 *
 * Returns the first offender only, for gate 14's reason: the remedy is one
 * number, and the criteria after it are consequences rather than findings.
 */
/**
 * ⚠️ `targetRepos` is a list of NAMES, and stays one under the reference model
 * (Story MOTIR-2732 · MOTIR-3041, ADR "Amendment 2026-08-18" §A4.2).
 *
 * This comparison has a name on BOTH sides by necessity: the other side is a path
 * written in a card's PROSE, and prose contains names, not row ids. So nothing
 * here changes shape. What changes is only where the card's side COMES FROM — the
 * references, resolved once through §A4's rule, rather than read off a column
 * that happened to hold the answer.
 *
 * Stated rather than left implicit because the two look identical at this call
 * site and are not: a resolved name follows a repository rename and a stored one
 * does not, so an advisory reading the wrong source would start reporting a
 * straddle the moment somebody renamed a repository on the host.
 */
export function firstRepoStraddleCriterion(
  md: string | null | undefined,
  targetRepos: readonly string[],
  candidates: readonly RepoCandidate[],
): RepoStraddleCriterion | null {
  const paths = criterionRepoPaths(md, candidates);
  if (paths.length === 0) return null;

  if (targetRepos.length > 0) {
    const carried = new Set(targetRepos.map((r) => r.toLowerCase()));
    const offender = paths.find(
      (p) =>
        !carried.has(p.repo.toLowerCase()) &&
        !isCarriedNamespaceDirectory(p.path, carried, candidates),
    );
    return offender ? { ...offender, reason: 'contradiction' } : null;
  }

  const first = (paths[0] as CriterionRepoPath).repo.toLowerCase();
  const second = paths.find((p) => p.repo.toLowerCase() !== first);
  return second ? { ...second, reason: 'unpinnable' } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SUBSUMPTION CHECK (MOTIR-2903) — "is this card's deliverable already in
// the repository?", asked of the one artifact where the overlap is a FACT.
//
// A different question again from the three above, and the reason it needs a
// data source none of them touches. The reference scan compares a body against
// the GRAPH; the two shape checks read a body against ITSELF. This one compares
// a body against the REPOSITORY — because the plan, on its own, cannot answer
// it. MOTIR-2757's work was swept up by MOTIR-2846, and MOTIR-2846's
// description contains not one of `workflowsService`, `getWorkflow`,
// `listStatusesByProject`, `getStatusByKey` or `lib/services/workflowsService.ts`
// — nor does its parent story, nor any of that story's twenty-one children. Two
// authors described the same change in disjoint vocabularies, one naming a
// scanner's verdict list and the other naming three methods. The commit that
// touched `lib/services/workflowsService.ts` is the ONLY place the two meet.
//
// So the rule, as amended on MOTIR-2903 by the close-out of MOTIR-2923:
//
//   at least ONE path the card's BODY names was touched by a merged pull
//   request that is not this card's own, and that merged AFTER this card was
//   filed.
//
// ⚠️ Every clause of that is load-bearing, and the two the card originally
// carried were MEASURED to fire on nothing:
//  - **BODY, not acceptance criteria.** The only path in MOTIR-2757's AC span is
//    `tests/permissions/userlessTenantRead.test.ts`, which has no commits since
//    that card was filed; the path the sweep actually took sits in its CONTEXT
//    REFS. An AC-scoped scan reads well and never fires.
//  - **At least ONE, not EVERY.** Of the five paths MOTIR-2757's body names,
//    `c99efdc7` touched two. Full coverage is the same rule that fires never.
//
// The pure half is here: which paths a body names, and whether the card has
// opted out. The repository read and the coverage decision live in
// `proseGraphAdvisoryService`, on `githubPullRequestRepository`'s
// `findMergedTouchingPaths` (MOTIR-2922) — this module stays IO-free.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A path token's final segment must carry an EXTENSION for the token to count
 * as a file path. This is what keeps the check a reading of file names rather
 * than a guess about what a slash means: `ghcr.io/token`, `app.motir.co/api/mcp`
 * and `github.com/moooon-B-V/motir-meta/pull/211` all end in an extensionless
 * segment and are dropped, while `lib/services/workflowsService.ts` and
 * `docs/rls-runtime-role-inventory.md` are kept.
 */
const PATH_EXTENSION_RE = /\.[A-Za-z0-9]+$/;

/**
 * Trailing sentence punctuation the token regex swallows. `.` is in
 * {@link PATH_TOKEN_RE}'s character class (it has to be — extensions), so a path
 * ending a sentence arrives as `lib/db.ts.` and would fail the extension test.
 */
const TRAILING_DOTS_RE = /\.+$/;

/**
 * How many distinct paths one body contributes to the subsumption query.
 *
 * A cap on UNBOUNDED input, in the same spirit as `MAX_CAPTURED_PR_PATHS` on the
 * capture side, and stated rather than sliced at the call site. Hitting it is
 * not observed in this corpus — the widest card body names fewer than twenty
 * paths — and the consequence if it ever is hit is a MISSED advisory, never a
 * wrong one: the check reports the first covered path, so dropping the tail can
 * only lose a finding on a channel that never blocks.
 */
export const MAX_SUBSUMPTION_QUERY_PATHS = 200;

/**
 * The repo-relative file paths a body NAMES, in document order, deduped.
 *
 * Scope is the WHOLE body, deliberately — see the module note: the path that
 * catches the canonical fixture lives in its Context refs, not in its criteria.
 * That is the inverse of both shape checks, which scan the AC span only, and the
 * difference is the finding's nature: a mis-shaped criterion is a defect in what
 * the card ASKS FOR, while a subsumed card is a fact about what it DESCRIBES.
 *
 * Inline markup is stripped first (the corpus writes paths in backticks), and a
 * trailing `:274` line reference falls away for free — `:` is not in
 * {@link PATH_TOKEN_RE}'s class, so `docs/x.md:274` yields `docs/x.md`.
 *
 * ⚠️ KNOWN BLIND SPOT — a REPO-QUALIFIED path (`motir-ai/src/foo.ts`) is
 * returned verbatim and therefore matches nothing, because `changed_paths`
 * stores what GitHub reports and GitHub reports repo-RELATIVE paths. Stripping
 * the prefix would need the workspace's connected-repository set, which would
 * make this function impure and candidate-dependent for a form the corpus writes
 * rarely. The cost is a MISS on such a card, on a non-blocking channel; the
 * alternative — guessing that a leading segment is a repo name — would cost
 * false positives on every `docs/decisions/x.md`-shaped path.
 */
export function bodyFilePaths(md: string | null | undefined): string[] {
  if (!md) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of md.replace(INLINE_MARKUP_RE, '').matchAll(PATH_TOKEN_RE)) {
    const token = (m[0] as string).replace(TRAILING_DOTS_RE, '');
    if (!PATH_EXTENSION_RE.test(token)) continue;
    if (token.split('/').filter((s) => s.length > 0).length < 2) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length === MAX_SUBSUMPTION_QUERY_PATHS) break;
  }
  return out;
}

/**
 * The phrases by which a card DECLARES itself a boundary contract — a producer
 * plus its mirrored consumer, two coordinated pull requests, legitimately one
 * card (`plan-rules/kind-leaf.md`'s two-PRs-one-card rule).
 *
 * Matched case-insensitively anywhere in the body, and pinned by
 * `tests/workItems/proseVsGraph.test.ts` so the list cannot drift silently.
 */
export const SUBSUMPTION_EXEMPT_PHRASES = [
  'two-prs-one-card',
  'boundary contract',
  'boundary-contract',
] as const;

const SUBSUMPTION_EXEMPT_MATCHERS: readonly RegExp[] = SUBSUMPTION_EXEMPT_PHRASES.map(
  (phrase) => new RegExp(`\\b${phrase.split(' ').join('\\s+')}\\b`, 'i'),
);

/**
 * Whether a card is EXEMPT from the subsumption check — the named predicate the
 * repo-straddle check deliberately does NOT have, and the reason it can exist
 * here when it could not there.
 *
 * The shape both checks fire on falsely is the same one: a boundary-contract
 * card shares paths with its sibling, so the sibling's merge covers a path this
 * card's body names and the advisory then fires **for as long as the card is
 * open**. That permanence is what makes it worth an opt-out. A straddle
 * advisory is a one-off reading of a static body; this one re-fires on every
 * dispatch, every claim and every validate until the card closes, so an accepted
 * false positive here is not one line of output but a standing one.
 *
 * ⚠️ **The exemption is the card SAYING it, and nothing else.** There is no
 * signal in the graph for "these two cards are one contract" — an absent edge
 * and a considered exclusion are the same absent edge (`run.md`: *silence is not
 * an exclusion*) — so the only honest mute is an assertion the author writes
 * down, in the body, where a reader meets it. Deliberately NOT keyed on
 * `type` / `executor` the way {@link isOrderingCheckExempt} is: gate 14's
 * exemption is the rule's own remedy read back (a `deploy` card is DEFINED by
 * needing the merge), while no card KIND is defined by being a boundary
 * contract.
 */
export function isSubsumptionCheckExempt(md: string | null | undefined): boolean {
  if (!md) return false;
  return SUBSUMPTION_EXEMPT_MATCHERS.some((re) => re.test(md));
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ESTIMATION-GATE SIZING CHECK (MOTIR-3110) — the third member of the SHAPE
// family, and the only one that reads no prose at all.
//
// The planner's estimation gate (`plan-rules/kind-leaf-deepen.md`) puts two
// ceilings on a `coding_agent` LEAF: `storyPoints >= 8` is its literal SPLIT
// signal, and the agent run must be ≤ 60 minutes. Nothing in the product checked
// either, and four cards have now been sealed over it by an author who
// understood the gate perfectly and wrote the correct remedy into the card's own
// description — MOTIR-1180, MOTIR-1229, MOTIR-1452 and MOTIR-3068, the last of
// which reached a run at 13 SP / 600 min with "Expect this to SPLIT" in its body
// (`notes.html` #323). The OUTPUT of the analysis kept going into a field the
// plan does not read.
//
// So this is the same promotion `likely-ordering-violation` and
// `likely-repo-straddle` each got — a check a person keeps rationalising past,
// moved into the channel a machine reads — and it is the cheapest member the
// family will ever have: two integer columns and an enum, no prose parsing and
// no judgement.
//
// ⚠️ CORRECTED BY MOTIR-3271. This paragraph used to end "…and no false-positive
// class needing a `reason` discriminator". That was true of the POINTS arm and
// false of the MINUTES one, and the half that was right is what lent the other
// half its confidence. `8+` is the gate's own literal split signal, read off
// the card's own points column. The minutes arm reads `estimateMinutes`, which
// the same pack DEFINES as agent run time PLUS CI time, against a ceiling the
// gate places on the agent run ALONE ("EXCLUDING CI … NOT the PR's CI pipeline
// (which you don't control)"). One of the two integers is not the integer the
// rule is about, so the minutes arm is a PROXY with a real false-positive class
// — a short run behind a heavy CI leg. Cheapness was never in doubt; what was
// wrong was reading cheap inputs as an exact reading.

/**
 * The estimation gate's SPLIT signal: a `coding_agent` leaf at or above this
 * many story points is asking to be split.
 *
 * At-or-above, not above: 8 is the signal itself, not the first value past it.
 *
 * ⚠️ 13 → 8, AND THE POINTS ARM WAS DEAD UNTIL IT (MOTIR-5588 · PRODECT_FINDINGS
 * #106). The planner is given the Fibonacci deck `1 / 2 / 3 / 5 / 8` and told
 * that **8 IS the split signal for a subtask** — so a planner-authored leaf can
 * never reach 13, and this arm fired only on a hand-entered number. The one
 * value the rule calls a split signal produced no advisory at all.
 *
 * ⚠️ AND THE CITATION IT CARRIED WAS TWICE STALE. It quoted
 * the estimation gate — *"reserve the top of the deck for a subtask that should
 * be split"* — and that pack is RETIRED, and neither rule home contains that
 * sentence any more. Both now say `8`. A threshold pinned to a corpus sentence
 * is a threshold that goes stale silently when the sentence moves, so this
 * comment states the RULE rather than quoting a file: the deck tops out at 8,
 * and the top of the deck is the split signal.
 */
export const ESTIMATION_GATE_STORY_POINTS = 8;

/**
 * The estimation gate's minutes threshold — the value `estimateMinutes` must
 * EXCEED before this check fires. It is a **PROXY FOR the gate's ceiling, not
 * the ceiling itself**, and that distinction is the whole reason this comment is
 * long (MOTIR-3271).
 *
 * **What the gate ceilings.** `plan-rules/kind-leaf-deepen.md`: *"THE RUN-TIME
 * CEILING — coding-agent run time (EXCLUDING CI) must be ≤ 1h … The ceiling is
 * on the agent-run component alone — the model's authoring/iteration wall-clock,
 * NOT the PR's CI pipeline (which you don't control)."*
 *
 * **What this column holds.** The same pack, four lines above: *"`estimate`
 * (`estimateMinutes`) = coding-agent run time + CI-pipeline time summed into one
 * minutes number"*, with CI *"~15–30 min"* and *"typically the LARGER half of
 * the total for a right-sized card."*
 *
 * So the ceiling is on ONE ADDEND and this column is the SUM. No threshold on
 * the sum can decide the addend, and nothing in the column separates them —
 * which is why every value here trades false positives against false negatives
 * rather than being correct.
 *
 * **Why 70, and what it was.** This was `60`: the ceiling's own number applied
 * to the wrong quantity, so it fired on the whole upper half of a band the
 * gate's own calibration table endorses.
 *
 * ```text
 * pts | agent run        | + CI  | total
 * ----+------------------+-------+--------
 *   3 | ~10–15 min       | 20–30 | ~30–45
 *   5 | ~18–30 min       | 25–40 | ~50–70
 *   8 | ~35–50 → SPLIT   |   —   |   —
 * ```
 *
 * `70` is the top of the largest band that table endorses, so the threshold now
 * reads *"a total larger than the largest total the gate's own calibration says
 * a right-sized card can have"*. Two cards measured on 2026-08-20 bracket it and
 * are why it is not higher: **MOTIR-3239** at 5 SP / **65** min fired and was a
 * FALSE positive (inside the 50–70 band), and **MOTIR-3229** at 5 SP / **90**
 * min fired and was a TRUE one — its actual run was written back at ~1h05, over
 * the hour. The arithmetic first proposed for this fix (an at-ceiling 60-minute
 * run plus 15–40 of CI, so ~100) would have silenced the true one.
 *
 * **The residual error classes, named rather than denied.** A FALSE POSITIVE
 * survives: a short run behind a heavy CI leg (20 + 60 = 80) fires. A FALSE
 * NEGATIVE survives too: a run over the hour with a trivial CI leg can total
 * ≤ 70. Both are irreducible while one column carries two times; the schema
 * change that would end it — storing agent minutes apart from CI minutes — is
 * deliberately out of scope here and named so it is refused on the record. It is
 * because they survive that every surface RENDERING a `threshold:
 * 'estimate_minutes'` finding says the number is a proxy.
 *
 * STRICTLY above, unlike the points threshold: a card sitting exactly on 70 is
 * inside the gate. ({@link ESTIMATION_GATE_STORY_POINTS} is at-or-above because
 * `13` IS the signal; this number is not the gate's own, so it cannot be one.)
 */
export const ESTIMATION_GATE_ESTIMATE_MINUTES = 70;

/**
 * WHICH of the two ceilings a card crossed — one advisory says both.
 *
 * The two arms do NOT carry the same authority, and a renderer must not present
 * them as if they did (MOTIR-3271). `story_points` IS the rule: `8+` is the
 * gate's literal split signal. `estimate_minutes` is a PROXY for it — see
 * {@link ESTIMATION_GATE_ESTIMATE_MINUTES}.
 */
export type OverGateThreshold = 'story_points' | 'estimate_minutes' | 'both';

/** The SIZING finding: which ceiling(s), and the values that crossed them. */
export interface OverGateSizing {
  threshold: OverGateThreshold;
  /** The card's own `storyPoints`, as observed — `null` when unestimated. */
  storyPoints: number | null;
  /**
   * The card's own `estimateMinutes`, as observed — `null` when unestimated.
   * The SUM of agent run time and CI time, which is why the minutes arm reading
   * it is a proxy (MOTIR-3271).
   */
  estimateMinutes: number | null;
}

/**
 * The card's sizing read against the estimation gate, or `null` when it is
 * inside both ceilings (or exempt from them).
 *
 * Two exemptions, and both are the rule's own scope read back rather than noise
 * filters:
 *
 *  - **Executor.** The ceilings are about AGENT run time. A `human` executor's
 *    minutes are human work — a two-day dashboard chore is correctly sized at
 *    600 — and a `manual` card takes `executor: 'human'` from the type→executor
 *    default map, so testing the executor covers both and testing the TYPE would
 *    cover neither reliably. Anything that is not `coding_agent` is out of
 *    scope, including an untyped card that carries no executor at all: this
 *    check reports a card whose sizing contradicts a rule it is subject to, and
 *    a card with no executor is not yet subject to it.
 *  - **Position, not kind.** A card with CHILDREN is sized by rollup, so its own
 *    columns describe a subtree rather than a run and the gate does not reach
 *    them. `hasChildren` is therefore the condition — the same leaf-POSITION
 *    definition the estimation gate itself uses, which is why a childless `bug`
 *    or `task` is IN scope exactly as a `subtask` is (MOTIR-3068 was a `bug`).
 *
 * A `null` on either column is unestimated, never zero: it cannot cross a
 * ceiling, and the gate's *"every leaf MUST carry a non-null estimate"* limb is
 * a different finding this check deliberately does not make.
 */
export function overGateSizing(card: {
  executor: string | null | undefined;
  hasChildren: boolean;
  storyPoints: number | null | undefined;
  estimateMinutes: number | null | undefined;
}): OverGateSizing | null {
  if (card.executor !== 'coding_agent') return null;
  if (card.hasChildren) return null;

  const storyPoints = card.storyPoints ?? null;
  const estimateMinutes = card.estimateMinutes ?? null;
  const overPoints = storyPoints !== null && storyPoints >= ESTIMATION_GATE_STORY_POINTS;
  const overMinutes =
    estimateMinutes !== null && estimateMinutes > ESTIMATION_GATE_ESTIMATE_MINUTES;
  if (!overPoints && !overMinutes) return null;

  return {
    threshold:
      overPoints && overMinutes ? 'both' : overPoints ? 'story_points' : 'estimate_minutes',
    storyPoints,
    estimateMinutes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE UNDER-AUTHORED CHECK (MOTIR-5427) — a childless leaf that carries NOTHING a
// run, a reviewer or a detector reads.
//
// Plan-rules gate 20 says a work item with no acceptance criteria is UNSEALABLE
// because every criterion-level gate passes an empty list vacuously, and it says
// its own mechanical gap out loud: the over-sizing detector returns at its
// `executor` guard, `likely-repo-straddle` reads the criteria for foreign paths,
// so a leaf with no executor, no numbers and no criteria is invisible to both.
// MOTIR-4956 sealed `ready: true` / `valid: true` in exactly that state.
//
// This is a NULL CHECK, not the sizing advisory `CORPUS-MAINTENANCE.md` measured
// and rejected: that rejection was about a plausible number sized for the wrong
// half of a card (a judgement), while here every input is an ABSENT field. A leaf
// either has an enumerated criterion under an `## Acceptance criteria` heading or
// it does not; a column is either null or it is not. See
// `docs/decisions/under-authored-shape-family.md`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY a card has no criteria: `no-heading` (no `## Acceptance criteria` section at
 * all) or `no-criterion` (the heading is there and nothing is enumerated under it).
 */
export type UnderAuthoredCriteria = 'no-heading' | 'no-criterion';

/** The UNDER-AUTHORED finding. */
export interface UnderAuthored {
  criteria: UnderAuthoredCriteria;
}

/**
 * The card read for under-authoring, or `null` when it is not.
 *
 * Fires only on a CHILDLESS card carrying ALL of: no enumerated acceptance
 * criterion, `storyPoints` null, `estimateMinutes` null, `type` null and
 * `executor` null. The conjunction is deliberate. A card missing only some of
 * them is a card mid-authoring or a human card that legitimately carries no
 * estimate; a card missing every one is not described by any other check.
 *
 * `hasChildren` is the gate's own scope, not a noise filter: gate 20 is a LEAF
 * bar, and a container's body is its subtree's, so a parent is never reported
 * whatever it carries.
 */
export function underAuthored(card: {
  /**
   * The card's kind, when the caller has it. A container KIND (epic / story) can
   * never carry a `type` or `executor` — the service refuses one — so null columns
   * are not a defect there, and a childless story awaiting its children is not an
   * under-authored leaf. Absent means the caller does not know, and is not exempt.
   */
  kind?: string | null | undefined;
  descriptionMd: string | null | undefined;
  hasChildren: boolean;
  storyPoints: number | null | undefined;
  estimateMinutes: number | null | undefined;
  type: string | null | undefined;
  executor: string | null | undefined;
}): UnderAuthored | null {
  if (card.hasChildren) return null;
  if (card.kind != null && !isTypeableKind(card.kind as WorkItemKindDto)) return null;
  if (card.storyPoints != null || card.estimateMinutes != null) return null;
  if (card.type != null || card.executor != null) return null;
  // One parse of the body against the registry decides "has criteria": a
  // criterion is a FOUND acceptanceCriteria section; a heading with nothing under
  // it is HEADED but not found. An unknown kind reads as a task, the cell every
  // childless leaf shares.
  const parsed = parseSections(
    card.descriptionMd,
    (card.kind ?? 'task') as IssueType,
    (card.type ?? null) as SectionType,
  );
  if (parsed.found.includes('acceptanceCriteria')) return null;
  return {
    criteria: parsed.headed.includes('acceptanceCriteria') ? 'no-criterion' : 'no-heading',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SELF-BLOCKING-DESIGN CHECK (MOTIR-3178) — the fourth member of the SHAPE
// family, and the planning-time design gate read for its PURPOSE rather than its
// letter.
//
// The gate (`plan-rules/kind-leaf.md`) requires a UI-touching card to be linked
// to the design asset AND to *"the `type: design` subtask that produced (or will
// produce) it"*. On a card that DRAWS its own design that second link resolves to
// the card itself: the requirement is literally satisfied, and Principle #13 is
// exactly inverted — the drawing and the files written to match it arrive in one
// pull request, approved by one click. MOTIR-3154 carried its `design/ai-planning/`
// amendment as criterion 1 and the UI built against that drawing as criteria 4
// and 5, and every signal read green: `readiness.ready`, `openBlockers: []`,
// `valid: true` (`notes.html` #329, planning bug MOTIR-3158).
//
// So the question this asks is answerable from the card ALONE, which is what
// makes it a `shape` member rather than a reference one: does one criterion
// produce a DESIGN ASSET while another builds a RENDERED SURFACE? That is the
// same criterion-by-criterion method {@link criterionRepoPaths} already runs on
// the REPO axis, pointed at the DESIGN axis.
//
// ⚠️ A DESIGN-ASSET criterion is NEVER also read as a surface criterion, and
// that exclusion is the check's main precision instrument, not a tidiness rule.
// A `design` card's own criteria talk about surfaces constantly — the mock SHOWS
// the empty state, the export DRAWS the picker open — because describing a
// surface is what a drawing does. Attributing the two roles to two DIFFERENT
// criteria is the whole finding: one card producing the drawing AND the code.
//
// ⚠️ Advisory, never a blocker, and here the false-positive class is real and
// accepted rather than argued away (MOTIR-3158's decision): the predicate is
// lexical over criterion prose, so a design card that amends an asset and
// adjusts the one rendered surface reading it can fire. Blocking would hold such
// a card out of the ready set with no override — and a card that is its own
// design blocker is precisely the card a re-plan is in the middle of splitting.
// Where the enforcement needs to bite it already does: `run.md` guard #3 PAUSES
// a run about to build UI with no drawing. This makes the composition VISIBLE at
// seal time and at claim time; it is not a second, weaker copy of that guard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tells that a criterion's DELIVERABLE is a DESIGN ASSET — the three-file set
 * `motir-core/design/<area>/` holds (`design-notes.md` + a `.pen` source or a
 * `*.mock.html` + a same-basename export).
 *
 * Deliberately the SHAPE of the deliverable and never the word "design": a
 * criterion saying *"in the treatment the design decides"* is CONSUMING a
 * drawing, which is the other half of the finding and must not be mistaken for
 * producing one.
 */
const DESIGN_ASSET_MATCHERS: ReadonlyArray<RegExp> = [
  // A `design/<area>/…` path, with or without a repo prefix in front of it.
  /(?:^|[^A-Za-z0-9_.-])design\/[A-Za-z0-9_.-]+\//i,
  /\.mock\.html\b/i,
  /\bdesign-notes\.md\b/i,
  /\.pen\b/i,
  /\bthree-file\b/i,
  // ── The SUBJECT, not only the PATH (MOTIR-3625) ────────────────────────────
  // A criterion can be ABOUT a design artefact while naming no file at all. The
  // canonical one is an EXPORT spec — *"each `.png` is a full-page export of its
  // own mock rendered … at `deviceScaleFactor: 2`"* — which names the thing it
  // exports and no path, so the path-only reading saw `page` + `rendered` and
  // read a design card's own export criterion as the surface that card draws.
  // The card was then reported against ITSELF, which is the one shape the
  // exclusion below exists to prevent.
  //
  // ⚠️ A BARE `.png` IS DELIBERATELY NOT A TELL. It is also an upload format and
  // an avatar's, so `\.png\b` alone would MANUFACTURE a design criterion on a
  // card that has none — and a manufactured design criterion plus any ordinary
  // render criterion is a brand-new false positive, the exact cost this widening
  // is paying down. Every export criterion that motivated it names its mock.
  //
  // A BARE `mock` / `mocks` is read by {@link namesDesignAsset} instead, because
  // the word has a second meaning this corpus uses constantly (below).
  /\bmock-?ups?\b/i,
  /\bartboards?\b/i,
  /\bdesign assets?\b/i,
];

// ── A TEST DOUBLE is not a drawing ───────────────────────────────────────────
// A bare `mock` is the commonest export tell above — and the commonest word for
// a TEST DOUBLE in every test card's criteria: *"asserted on the boundary mock"*,
// *"no test mocks the helper wholesale"*, *"the lane's `E2E_TEST_BILLING`
// boundary mock"*. Read as a design asset, such a criterion becomes the DESIGN
// half of the finding, and the card's ordinary render criterion the SURFACE
// half, so a test or route card that draws nothing is reported as its own
// design blocker. Plan `cmvez6dl300gmhmrffl127q95` (2026-10-19) carried four
// such cards — MOTIR-8637, MOTIR-8640, MOTIR-8643 and the larger-pool E2E —
// and `check-plan` read each advisory as a guard #3 stop.
//
// So a bare `mock` counts only on a line that does not use it as a test double:
// the verb (*mocks the*, *mocked*, *mocking*, `vi.mock`), a double's noun
// before it (*boundary mock*, *fetch mock*), the thing it stands in for after
// it (*mock client*, *mock module*), a module specifier or path after the verb
// (*mocks @/lib/foo*, *mocks ./foo*, *mocks lib/x* — MOTIR-9077), or an
// assertion read off it (*asserted on the mock*). `*.mock.html` and *mockup* stay tells on any line, so a design
// card's export criterion is unaffected.
//
// ⚠️ The assertion arm keys on the GRAMMAR of a double, not on its adjective
// (MOTIR-9263). *"(asserted by the shared mock's argument identity)"* fired as a
// design asset: the arm took only *asserted ON*, and its noun-before list had no
// *shared* — and growing that list one adjective at a time is the fix this
// detector has already had five times. So the arm takes *asserted / checked BY*
// as well as *ON*, with any one modifier before the mock, and a POSSESSIVE mock
// followed by what a double records (*the mock's arguments / calls / identity /
// invocations*) is a double too. *"the mock's P3 panel"* names a drawing's part
// and stays a tell.
const BARE_MOCK_RE = /\bmocks?\b/i;

const TEST_DOUBLE_MOCK_RE =
  /\b(?:vi|jest)\.mock\b|\bmock(?:ed|ing)\b|\bmocks?\s+(?:the|a|an|its|every|each|out)\b|\b(?:boundary|test|stub|fake|spy|http|fetch|network|transport|server|client|module)\s+mocks?\b|\b(?:asserted|asserts?|recorded|seen|checked|counted)\s+(?:on|by)\s+(?:the\s+)?(?:[\w-]+\s+)?mocks?\b|\bmock['’]s\s+(?:arguments?|calls?|identity|identities|invocations?)\b|\bmocks?\s+(?:@\/|\.{1,2}\/|(?!and\/or\b)[\w@.()[\]-]+\/[\w@.()[\]-]+)|\bmocks?\s+(?:clients?|servers?|fetch|calls?|responses?|requests?|modules?|helpers?|leaf|leaves|routes?|boundar(?:y|ies)|transports?|gateways?|adapters?|implementations?|functions?|handlers?)\b/i;

// ── The AMENDMENT, not only the NEW ASSET (MOTIR-4477) ───────────────────────
// Every matcher above is an ASSET tell — a file, a path, or a word for a
// drawing. A criterion that commissions a design as an AMENDMENT TO AN EXISTING
// DESIGN DOCUMENT names none of them, because there is no new file: the
// deliverable is a section inside a note that already ships. The observed
// fixture, which is MOTIR-4472's criterion 1 as authored:
//
//   *"A design section exists amending Part XIV with the decided axis for
//   `modify` and `remove`, naming the chosen answer and the copy for every
//   string that changes — read before the code is written."*
//
// Run the eight matchers over it and every one misses — it says *"a design
// SECTION"* and *"Part XIV"*, and the `design-notes.md` path was in that card's
// Context refs, which {@link acceptanceCriteriaSpan} does not reach. So
// `designCriterionIndex` stayed null, the pair was never formed, and a card that
// was its own design blocker sealed with `advisories: []`.
//
// ⚠️ IT STRENGTHENS WITH MATURITY, which is why it is worth a matcher rather
// than a note. Once an area HAS a design document, the natural phrasing for new
// design work is an amendment to it — *"a section amending Part XIV"*, *"§7
// gains a decided arm"* — which is better writing than *"a new design asset"*
// and invisible to a list of file tells. The detector is quietest exactly where
// the design corpus is most established.
//
// ⚠️ IT IS A COMPOUND, AND NEITHER HALF IS A TELL ON ITS OWN — the same
// asymmetry the bare `.png` note above records, in the other direction. *Amend*
// and *section* are two of the commonest words in this corpus; a matcher on
// either alone would MANUFACTURE a design criterion on cards that have none, and
// a manufactured design criterion plus any ordinary render criterion is a
// brand-new false positive. So it requires a DESIGN-QUALIFIED document noun
// (*the design notes*, *a design section*, *the design spec*) AND an amendment
// verb, in one criterion. A docs card amending an ADR, or a criterion citing
// *"§3 of the decision record"*, carries the verb and no design-qualified noun
// and stays silent — which is the floor `tests/` asserts with a string taken
// from a real non-design card.
//
// ⚠️ AND A BARE `Part <ROMAN>` / `§<n>` IS DELIBERATELY NOT THE NOUN. Section
// numbering is how every decision record in `docs/decisions/` cites itself, so
// it identifies a DOCUMENT and says nothing about which kind — the word that
// carries the design claim is `design`, and it has to be adjacent to the noun
// rather than anywhere in the criterion.

/**
 * A DESIGN DOCUMENT named as a DOCUMENT rather than as a file — *"a design
 * section"*, *"the design notes"*, *"the design spec"*, *"the design document"*,
 * *"the design of record"*. The qualifier is what makes it a design tell.
 */
const DESIGN_DOCUMENT_NOUN_RE =
  /\bdesign(?:'s)?[\s-]+(?:notes?|docs?|documents?|specs?|specifications?|sections?|records?)\b|\b(?:notes?|docs?|documents?|specs?|sections?)\s+of\s+(?:the\s+)?design\b|\bdesign\s+of\s+record\b/i;

/**
 * An UNAMBIGUOUS amendment verb — a word whose only ordinary reading is *this
 * document is being changed*. *"cites Part XIV"* is a card reading a design;
 * *"amends Part XIV"* is a card writing one, and only the second is a design
 * deliverable. Safe to look for anywhere in the criterion, because none of these
 * is a thing a card does to a COMPONENT.
 */
const DESIGN_AMENDMENT_VERB_RE =
  /\b(?:amend(?:s|ed|ing|ment|ments)?|supersed(?:e|es|ed)|revis(?:e|es|ed|ion|ions)|(?:is|are|was|were)\s+updated\s+to\s+cover|(?:is|are|was|were)\s+added\s+to)\b/i;

/**
 * A GROWTH verb whose SUBJECT is the design document itself — *"the design notes
 * GAIN a decided arm"*.
 *
 * ⚠️ These verbs are split off deliberately, and the subject constraint is the
 * whole reason. *Gains* / *extends* / *adds* describe a card changing a
 * COMPONENT at least as often as a document — *"the peek GAINS a decided arm,
 * per the design notes"* is a code criterion CONSUMING a drawing, and a
 * proximity test cannot tell it from the sentence above, because in both the two
 * words are a few characters apart. So the document has to be what does the
 * gaining: the noun immediately precedes the verb, within one clause.
 */
const DESIGN_DOCUMENT_GROWS_RE =
  /\bdesign(?:'s)?[\s-]+(?:notes?|docs?|documents?|specs?|specifications?|sections?|records?)\b[^.;:]{0,30}?\b(?:gains?|gained|grows?|grew|extends?|extended|adds?|carries|carry)\b/i;

/**
 * Whether a criterion commissions an AMENDMENT to an existing design document.
 *
 * Evaluated over the WHOLE criterion — bullet plus continuation lines — because
 * it is a compound and its two halves routinely land on different lines of one
 * wrapped bullet. The asset matchers stay per-line, which is what they have
 * always been.
 */
export function namesDesignDocumentAmendment(text: string): boolean {
  if (DESIGN_DOCUMENT_NOUN_RE.test(text) && DESIGN_AMENDMENT_VERB_RE.test(text)) return true;
  return DESIGN_DOCUMENT_GROWS_RE.test(text);
}

/**
 * Nouns that name a RENDERED SURFACE — something a person looks at in the running
 * app. Kept UI-specific on purpose: `card`, `row`, `list`, `field` and `table` all
 * mean something else far more often in this corpus, and one of them would fire
 * on nearly every criterion ever written here.
 *
 * A POSSESSIVE is not the noun (*"the dialog's request opens a transaction"*):
 * there the surface modifies another subject, and that subject owns the verb.
 */
const SURFACE_NOUN_SRC =
  "\\b(?:page|screen|view|panel|pane|canvas|modal|dialog|drawer|sidebar|rail|tab|toolbar|banner|toast|tooltip|popover|overlay|breadcrumb|board|picker|combobox|dropdown|menu|nav|navigation|surface|component|badge|chip|button|empty state)s?\\b(?!['’]s?\\b)";

/** Verbs that put such a noun ON SCREEN — the criterion is about what renders. */
const SURFACE_VERB_SRC =
  '\\b(?:renders?|rendered|draws?|drawn|shows?|shown|displays?|displayed|paints?|painted|appears?|is visible|opens?|highlights?|lists)\\b';

/**
 * How many words may sit between a surface noun and its verb and still be read
 * as one phrase — enough for an auxiliary, a number or a short modifier
 * (*"the surface IS rendered"*, *"Panel 12 draws"*, *"renders THE EMPTY state"*,
 * *"is drawn AS OPENING THE PLANNING surface"*), too few for a second subject
 * to arrive in between. The clause split does the rest: a subordinate clause's
 * own subject never shares a clause with the noun.
 */
const SURFACE_BIND_GAP = 4;

/**
 * A surface noun BOUND to its render verb, as the verb's subject (*"the page
 * renders"*) or its object (*"renders the page"*), within {@link SURFACE_BIND_GAP}
 * words. Run per CLAUSE (see {@link surfaceClauses}), never over the whole line.
 */
const SURFACE_BOUND_RE = new RegExp(
  `${SURFACE_NOUN_SRC}(?:\\s+\\S+){0,${SURFACE_BIND_GAP}}?\\s+${SURFACE_VERB_SRC}` +
    `|${SURFACE_VERB_SRC}(?:\\s+\\S+){0,${SURFACE_BIND_GAP}}?\\s+${SURFACE_NOUN_SRC}`,
  'i',
);

/**
 * Where one clause ends and the next begins: sentence and clause punctuation
 * (a full stop only when it ENDS a word, so `design-notes.md` and `1.5` stay
 * whole), a dash, a bracket, and the subordinators that open a clause with a
 * subject of its own — *"refused BEFORE any transaction opens"*.
 */
const CLAUSE_BREAK_RE =
  /[.!?](?=\s|$)|[;:()[\]—–]|\s-\s|\b(?:before|after|until|unless|while|whereas|because|since|once|whenever|when|if|then)\b/i;

/** A criterion line cut into the clauses the surface binding is tested within. */
function surfaceClauses(text: string): string[] {
  return text.split(new RegExp(CLAUSE_BREAK_RE.source, 'gi'));
}

/**
 * A React component path — a `.tsx` / `.jsx` file that is NOT part of a design
 * asset. An independent tell, because a criterion naming
 * `app/(authed)/plans/[id]/page.tsx` is a rendered surface whatever verbs it uses.
 */
const COMPONENT_PATH_RE = /[A-Za-z0-9_.@()[\]-]+(?:\/[A-Za-z0-9_.@()[\]-]+)*\.[jt]sx\b/i;

/**
 * Whether a criterion's own SUBJECT is a design asset — a path or an artefact.
 *
 * Exported so the predicate can be asserted directly against a fixture string
 * (MOTIR-4477): a widening asserted only through `selfBlockingDesignCriteria`
 * cannot say WHICH half moved.
 */
export function namesDesignAsset(text: string): boolean {
  if (DESIGN_ASSET_MATCHERS.some((re) => re.test(text))) return true;
  return BARE_MOCK_RE.test(text) && !TEST_DOUBLE_MOCK_RE.test(text);
}

/**
 * Whether a criterion builds or changes a RENDERED SURFACE — a surface noun put
 * on screen by a render verb, or a component path named outright.
 *
 * ⚠️ THE NOUN AND THE VERB MUST BE ONE PHRASE IN ONE CLAUSE (MOTIR-9263). Two
 * independent tests over the line read *"A page in another project is refused
 * before any transaction OPENS"* as a surface, because `page` matched and so did
 * `opens` — whose subject is the transaction. Every earlier false positive here
 * was closed by growing a word list; binding the verb to its noun, as
 * {@link DESIGN_DOCUMENT_GROWS_RE} already does for design documents, closes the
 * class instead.
 *
 * Exported so the predicate is asserted directly (MOTIR-4477's convention), not
 * only through {@link selfBlockingDesignCriteria}.
 */
export function namesRenderedSurface(text: string): boolean {
  if (COMPONENT_PATH_RE.test(text)) return true;
  return surfaceClauses(text).some((clause) => SURFACE_BOUND_RE.test(clause));
}

/**
 * Whether a card is OUTSIDE the self-blocking-design check's scope by its TYPE
 * alone (MOTIR-6245): a `type: design` card IS the design card the finding's
 * remedy would lift a criterion into, so the finding cannot be true of it.
 *
 * The prose predicate cannot answer this, and it must not be taught to. Its
 * per-criterion exclusion ({@link namesDesignAsset}) keys on the criterion naming
 * an artefact, so a design card's criterion that identifies its panels by NUMBER
 * (*"Panels 2, 3 and 10 show that growth moves nothing outside the rail"*,
 * MOTIR-6236) or obliges it to RENDER the shipped surface before drawing
 * (MOTIR-6241) names none and lands in the surface arm. Widening the artefact
 * matchers to catch both would be the *"any criterion on a card that produces
 * an asset"* reading {@link selfBlockingDesignCriteria} already rejects. The
 * card's own type is insensitive to which sentence the criterion used, so it is
 * the caller's third scope test beside `hasChildren` and `hasDesignBlocker`.
 *
 * Exported so the scope is asserted DIRECTLY rather than only through a fixture
 * a later widening of the prose predicate could silently re-open.
 */
export function isSelfBlockingDesignCheckExempt(type: string | null | undefined): boolean {
  return type === 'design';
}

/** The SELF-BLOCKING-DESIGN finding: the two criteria that must not share a card. */
export interface SelfBlockingDesignCriteria {
  /** 1-based index of the criterion whose deliverable is the DESIGN ASSET. */
  designCriterionIndex: number;
  /** 1-based index of the criterion that BUILDS the surface that drawing decides. */
  surfaceCriterionIndex: number;
}

/**
 * The two criteria that make a card its OWN design blocker, or `null`.
 *
 * Scope and attribution are {@link firstPostMergeCriterion}'s exactly — the
 * acceptance-criteria span only, enumerated criteria only, a continuation line
 * belonging to the bullet it wraps from — so all three criterion-reading shape
 * checks report ONE numbering and a card carrying several findings can be read
 * against it.
 *
 * Both indices are the FIRST of their kind, and BOTH are reported rather than one:
 * unlike gate 14's ordering violation the remedy is not a cut line but a LIFT —
 * the design criterion becomes its own `type: design` card that the rest of this
 * one is `blocked_by`. A reader needs to see both ends of the inversion to do that,
 * and a single index would name the half they already knew about.
 *
 * A criterion that names a design asset is excluded from the surface arm (see the
 * module note above), so a design card describing what its own drawing shows
 * stays quiet — and a card with no acceptance-criteria heading returns `null`
 * here, the same never-suppress-on-a-heuristic contract
 * {@link firstPostMergeCriterion} has.
 *
 * ⚠️ That exclusion is per-CRITERION and stays per-criterion (MOTIR-3625). What
 * widened is what makes a criterion a design one — the ARTEFACT matchers above,
 * so an export spec naming its mock rather than a path is excluded too. It did
 * NOT widen to *"any criterion on a card that produces an asset anywhere"*,
 * which reads well and is self-defeating: the design criterion is, by
 * construction, a criterion that names an asset, so that reading would leave
 * every card with a design criterion and none with a surface criterion, and the
 * check could never fire again.
 *
 * ⚠️ AND THIS FUNCTION READS NO EDGES, BY DESIGN. A card whose design is already
 * LIFTED into a sibling it is `blocked_by` still names the mock it consumes and
 * still builds the surface, so it is indistinguishable HERE from one that never
 * lifted anything. That population is separated by the caller, which holds the
 * graph — see `selfBlockingDesignAdvisory`'s `hasDesignBlocker`.
 */
export function selfBlockingDesignCriteria(
  md: string | null | undefined,
): SelfBlockingDesignCriteria | null {
  if (!md) return null;
  const span = acceptanceCriteriaSpan(md);
  if (!span) return null;

  let criterionIndex = 0;
  let designCriterionIndex: number | null = null;
  let surfaceCriterionIndex: number | null = null;
  // A criterion spans its bullet plus every continuation line, so the two roles
  // are decided per CRITERION and not per line: a criterion whose asset path sits
  // on the bullet and whose verb wraps to the next line is one criterion, once.
  let designHere = false;
  let surfaceHere = false;
  // The criterion's own text, joined — the amendment compound (MOTIR-4477) is
  // read over the WHOLE criterion, since its noun and its verb land on different
  // lines of a wrapped bullet as often as not.
  let criterionText = '';

  const settle = () => {
    if (criterionIndex === 0) return;
    if (designHere || namesDesignDocumentAmendment(criterionText)) {
      if (designCriterionIndex === null) designCriterionIndex = criterionIndex;
      return; // a design-asset criterion is never also the surface criterion
    }
    if (surfaceHere && surfaceCriterionIndex === null) surfaceCriterionIndex = criterionIndex;
  };

  for (const raw of md.slice(span.start, span.end).split('\n')) {
    if (CRITERION_BULLET_RE.test(raw)) {
      settle();
      criterionIndex += 1;
      designHere = false;
      surfaceHere = false;
      criterionText = '';
    }
    if (criterionIndex === 0) continue; // the heading and any lead-in prose
    const text = raw.replace(INLINE_MARKUP_RE, '');
    criterionText += `${text}\n`;
    if (namesDesignAsset(text)) designHere = true;
    if (namesRenderedSurface(text)) surfaceHere = true;
  }
  settle();

  return designCriterionIndex !== null && surfaceCriterionIndex !== null
    ? { designCriterionIndex, surfaceCriterionIndex }
    : null;
}

/**
 * The enumerated acceptance criteria of a body, one string per criterion, in
 * order — so a criterion's 1-based index is its position in this array plus one.
 *
 * Scope and attribution are {@link firstPostMergeCriterion}'s exactly: the
 * acceptance-criteria span only, a column-zero bullet (or `1.` item) opens a
 * criterion, and every continuation line belongs to the bullet it wraps from.
 * That is what lets the CONTAINER-COVERAGE check (MOTIR-5362) number criteria
 * the same way the shape checks do, so a container carrying findings from both
 * families is read against one numbering.
 *
 * The text is returned RAW — inline markup intact — because a caller may want the
 * backtick spans the markup delimits, and stripping is cheap for one that does not.
 * A body with no acceptance-criteria heading returns `[]`, never a guess.
 */
export function acceptanceCriteriaTexts(md: string | null | undefined): string[] {
  if (!md) return [];
  const span = acceptanceCriteriaSpan(md);
  if (!span) return [];

  const criteria: string[] = [];
  for (const raw of md.slice(span.start, span.end).split('\n')) {
    if (CRITERION_BULLET_RE.test(raw)) {
      criteria.push(raw);
      continue;
    }
    // Before the first bullet: the heading itself and any lead-in prose.
    if (criteria.length === 0) continue;
    criteria[criteria.length - 1] += `\n${raw}`;
  }
  return criteria;
}

// ── The MISLABELLED-LINK check (MOTIR-9007) ───────────────────────────────────
//
// A `[label](motir:<id>)` link whose label says one key while the id opens
// another card, or whose id opens no card at all. Every other check here reads
// the id and never the label, so a link the author wrote from memory — the label
// right, the id copied from a neighbouring card — passed every validation and
// rendered as a chip for the wrong card. The judgement is pure; the service
// resolves each id to its key first.

/** A work-item key anywhere in a label, any case: `MOTIR-7656`, `acme-12`. */
const LABEL_KEY_RE = /\b([A-Za-z][A-Za-z0-9]*)-(\d+)\b/g;

/**
 * The work-item keys a link LABEL names, upper-cased, in first-seen order — but
 * only those whose prefix is in `knownPrefixes` (the workspace's project keys,
 * upper-cased). A label is free text, so `UTF-8`, `RFC-9110` or `ADR-12` have
 * the shape of a key without being one; a prefix no project carries is read as
 * a word, which is what keeps a correct link with a descriptive label quiet.
 */
export function labelWorkItemKeys(label: string, knownPrefixes: ReadonlySet<string>): string[] {
  const keys: string[] = [];
  for (const m of label.matchAll(LABEL_KEY_RE)) {
    const prefix = (m[1] as string).toUpperCase();
    if (!knownPrefixes.has(prefix)) continue;
    const key = `${prefix}-${m[2] as string}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Is this link mislabelled? `targetKey` is the key its id resolves to, or `null`
 * when it resolves to no card the reader can see.
 *
 * - A link to NO card is mislabelled whatever its label says — the chip opens
 *   nothing, and that holds for a label that is a name as much as for a key.
 * - A link whose label names one or more keys, none of them the target's, is
 *   mislabelled: a reader trusts the label and acts on the wrong card.
 * - A label that names no key ("Epic 10", "the export story") is a NAME, and
 *   says nothing a target could contradict.
 *
 * A label naming several keys is satisfied by any one of them matching, since
 * "MOTIR-12 (was MOTIR-9)" is still a label for MOTIR-12.
 */
export function isMislabelledLink(
  label: string,
  targetKey: string | null,
  knownPrefixes: ReadonlySet<string>,
): boolean {
  if (targetKey === null) return true;
  const named = labelWorkItemKeys(label, knownPrefixes);
  return named.length > 0 && !named.includes(targetKey.toUpperCase());
}
