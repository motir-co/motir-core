import type { DispatchWorkflowMode } from '@/lib/dto/dispatch';
import { isAgentDecisionItem, isManualReadyItem } from '@/lib/dto/ready';
import {
  isBlockerCountAdvisory,
  isOrderingAdvisory,
  isReferenceAdvisory,
  isRepoStraddleAdvisory,
  isBodyAboveFieldMoveAdvisory,
  isSelfBlockingDesignAdvisory,
  isSizingAdvisory,
  isUnderAuthoredAdvisory,
  isSubsumptionAdvisory,
} from '@/lib/dto/workItems';
import { describeBodyAboveFieldMove } from '@/lib/workItems/bodyAboveFieldMove';
import type {
  ExecutorDto,
  WorkItemDifficultyDto,
  WorkItemKindDto,
  WorkItemObsolescenceDto,
  WorkItemPriorityDto,
  WorkItemProseAdvisoryDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import { splitPlanBody } from '@/lib/markdown/planBody';
import type { DesignVerdictDto } from '@/lib/dto/designAccess';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import type { LatestRefusalDTO } from '@/lib/dto/approvalGate';
import type { Locale } from '@/lib/i18n/locales';

// The canonical DISPATCH-PROMPT grammar (Story 7.9 · MOTIR-1802) — the
// open-core, deterministic rebuild of the cancelled 7.7.2 `generate_prompt` job.
//
// PURE: a function of its input record only. No DB, no I/O, no LLM call, no
// clock, no randomness — which is exactly the property the consumer (MOTIR-881,
// `motir next --print`) tests for. The SERVICE reads state and calls this; this
// module never reads anything.
//
// ⚠️ THE INPUT RECORD NOW INCLUDES THE RUN'S POLICY (MOTIR-3020), and the
// determinism property is RESTATED rather than weakened. It used to be phrased as
// "two calls for an unchanged ITEM return byte-identical output"; the honest form
// is two-sided:
//
//   • the same item WITH THE SAME POLICY returns byte-identical output; and
//   • the same item with a DIFFERENT policy returns DIFFERENT output — which has
//     to be asserted explicitly, or an inert switch passes every disabled-branch
//     test vacuously.
//
// This trades a property MOTIR-2406 stated deliberately — *"every instruction
// here is unconditional"* — and the trade is recorded in
// `docs/decisions/run-findings-protocol.md` Q1, not slipped in. What it costs:
// a prompt is no longer reproducible from the CARD alone, and two agents on one
// card can be told different things. What it buys: an operator can say what their
// agent may write, and a flag the prompt never carried could never have done
// that, because the prompt is the entire contract with a sandboxed agent.
// {@link FULL_FINDINGS_POLICY} is what an omitted policy means, and it is the
// complete protocol.
//
// The four sections (CONTEXT / WHAT TO DO / ACCEPTANCE CRITERIA / GIT WORKFLOW)
// productize the grammar `motir-meta/prompts/run.md` § *Prompt structure* has
// been applying by hand. Three shapes vary, and all three are decided HERE, from
// server state, never by the caller:
//
//   1. WHAT TO DO varies by the item's `type` (code / design / test / decision /
//      …) — a design card is told to produce a design asset, not code, and
//      whether it publishes a design result is decided by whether open work is
//      `blocked_by` it (MOTIR-5495).
//   2. A MANUAL item (`type: manual` or `executor: human`) gets the
//      human-INSTRUCTION form and NO `GIT WORKFLOW` section at all: there is no
//      branch, no PR, and telling a person to open one is noise.
//   3. GIT WORKFLOW varies by session lineage — see {@link DispatchWorkflowMode}.
//
// EXTENSION POINT — `injections` (see {@link DispatchPromptInjections}). The two
// enrichment cards that were left waiting on the cancelled assembly point
// (MOTIR-927, the project convention; MOTIR-1191, `coding`-type lessons) fill
// those named slots and nothing else. They are EMPTY here by design: both are
// Epic 9 / motir-ai work and building them in this repo would straddle the
// open-core boundary. See docs/decisions/dispatch-prompt-assembly.md.

/** The rule bar every section heading sits between. */
const RULE = '═'.repeat(60);

/**
 * WHEN a How-to-test record needs a CLICK-PATH (Story MOTIR-4906 · MOTIR-5334).
 *
 * ⚠️ THESE ARE THE RUNBOOK'S OWN WORDS, BYTE FOR BYTE — the scope sentence of
 * `motir-meta` `prompts/run.md` § *The how-to-test rule*. A person running the
 * runbook and a dispatched agent must agree on which cards owe a walk-through,
 * so the trigger has one text in two homes, and a test pins this constant to it.
 * Re-word it here and the runbook stops matching; re-word it there and the test
 * says so.
 */
export const RENDERED_SURFACE_TRIGGER =
  'creates or changes any rendered surface (a UI `type: code` subtask, or any subtask ' +
  'adding/editing a page, component, route-rendered view, modal, or interactive control)';

/**
 * The tool the FINISHED order's step 4b names. A literal, because this module is
 * a leaf that imports nothing from `lib/mcp/`; `tests/dispatch/promptTemplate.test.ts`
 * asserts it equals the REGISTERED tool name, so a rename fails there.
 */
export const HOW_TO_TEST_TOOL_NAME = 'publish_test_instructions';

/**
 * The tool BUILD THROUGH names (Story MOTIR-8651 · MOTIR-8658). A literal for the same reason
 * {@link HOW_TO_TEST_TOOL_NAME} is one, and `tests/dispatch/promptTemplate.test.ts` asserts it
 * equals the REGISTERED tool name, so a rename fails there rather than in a prompt an agent reads
 * weeks later.
 */
export const RECORD_DISCREPANCY_TOOL_NAME = 'record_run_discrepancy';

/**
 * The two DESIGN tools this prompt names, and the variable the CLI sets
 * (Story MOTIR-5553 · Subtask MOTIR-5563).
 *
 * Literals, because this module is a leaf that imports nothing from `lib/mcp/`
 * — the same reason {@link HOW_TO_TEST_TOOL_NAME} is one — and
 * `tests/dispatch/promptTemplate.test.ts` asserts each against the REGISTERED
 * tool name, so a rename fails there rather than in a prompt an agent reads six
 * weeks later.
 */
export const GET_DESIGN_TOOL_NAME = 'get_design';
export const LIST_DESIGNS_TOOL_NAME = 'list_designs';
/** The MCP read that returns a repository's coding convention (MOTIR-9084). */
export const GET_CODING_CONVENTION_TOOL_NAME = 'get_coding_convention';

/**
 * The environment variable the CLI sets when it has put the design on disk.
 *
 * ⚠️ THE OTHER HALF OF THIS NAME LIVES IN `packages/cli/src/designFiles.ts`, and
 * the two are pinned equal by a test in this module's suite — the only place
 * both are reachable, since this file cannot import a CLI module and that
 * package cannot import `lib/`. A drift makes this prompt name a variable
 * nothing sets, which reads to the agent as *there is no design*: the failure
 * with no error message.
 */
export const DESIGN_DIR_ENV = 'MOTIR_DESIGN_DIR';

/**
 * Named slots the Epic-9 enrichment cards fill — the ONE extension point this
 * assembly exposes. Each is a list of already-rendered Markdown blocks appended
 * to the CONTEXT section in a fixed order; empty (the only value this repo ever
 * supplies) renders nothing at all, so the prompt is unchanged until the
 * injecting card ships.
 */
export interface DispatchPromptInjections {
  /**
   * Retrieved `coding`-type lessons relevant to this item (MOTIR-1191), so a
   * known past mistake is never repeated. Blocked under Story 9.1 likewise.
   */
  lessons: string[];
}

/** The no-op injection set — what `motir-core` alone can supply today. */
export const NO_INJECTIONS: DispatchPromptInjections = { lessons: [] };

/** Everything the prompt is assembled from. Resolved by the service; the
 *  assembly reads nothing else. */
/**
 * The two capabilities a run may switch OFF for its agent (MOTIR-3020,
 * `docs/decisions/run-findings-protocol.md` Q1).
 *
 * Named after the CAPABILITY rather than the CLI flag that disables it: the
 * grammar must not inherit one client's `--disable-` prefix, and the same names
 * are what the `findingsPolicy` query parameter carries on the wire.
 */
export interface FindingsPolicy {
  /** May the agent FILE A BUG for a defect that is not about its own card? */
  logBug: boolean;
  /** May the agent SUBMIT A RE-PLAN when its own card's premise is false? */
  replan: boolean;
  /**
   * Is this run's loop willing to APPROVE a re-plan itself and carry on
   * (`motir auto --auto-approve-replan`) — MOTIR-4085.
   *
   * ⚠️ THE ODD ONE OUT, in two ways worth stating rather than inferring.
   *
   * It switches something ON, where the other two switch a capability OFF; and
   * it is not a capability of the AGENT at all. Nothing the agent may do changes
   * with it — the same two tools, the same anchor, the same one shot. What
   * changes is what happens to what it submits, which the agent cannot cause and
   * could not find out any other way.
   *
   * It is here because the prompt is the whole contract with a sandboxed agent,
   * and an agent that does not know its plan may be approved unattended cannot
   * make the one choice this policy leaves it: keep the plan inside its own
   * card's lane and the loop may approve it, or deliberately reach beyond that
   * lane — a container, a sibling story — and the plan goes to a person. Both are
   * legitimate, and an agent that believes a person will read every plan will
   * write the second kind when the first would do.
   *
   * ⚠️ AND IT IS NOT THE BOUND. The bound is the LOOP's: it reads the returned
   * plan, checks the lane, and approves or does not. This flag makes the choice
   * legible to the agent; it does not make the agent trusted.
   */
  autoApproveReplan: boolean;
}

/**
 * The default, and the reason the default is this way round.
 *
 * An omitted policy renders the COMPLETE protocol, so every existing caller —
 * and a human reading `motir run --print` to learn what an agent is told — sees
 * the whole contract. A prompt that quietly dropped a branch because a parameter
 * was absent would make the contract depend on how it was REQUESTED, which is the
 * failure the unconditional-prompt rule (MOTIR-2406) existed to prevent. What
 * this trades is narrower: an operator may now spend that property deliberately,
 * per run, and nothing spends it for them.
 */
export const FULL_FINDINGS_POLICY: FindingsPolicy = {
  logBug: true,
  replan: true,
  // ⚠️ FALSE IS THE COMPLETE PROTOCOL HERE, and it is the one field of the three
  // where the default is not "everything on". The other two default ON because
  // the full contract is what an omitted policy renders; this one defaults OFF
  // because an omitted policy means nobody asked for automatic approval, and a
  // prompt that told an agent its plan might be approved unattended when no loop
  // will approve it would be a lie in the direction that matters.
  autoApproveReplan: false,
};

/**
 * The wire vocabulary of {@link FindingsPolicy}: the tokens a caller may name to
 * DISABLE a capability. A closed set, and a list of what is OFF rather than a
 * mode, so a third capability adds one token instead of doubling an enum.
 */
export const FINDINGS_POLICY_TOKENS = ['log-bug', 'replan'] as const;

export type FindingsPolicyToken = (typeof FINDINGS_POLICY_TOKENS)[number];

/**
 * Parse the `findingsPolicy` parameter — a comma-separated list of DISABLED
 * capabilities — into the policy the template consumes.
 *
 * Shared by both transports on purpose: the `/api/v1` route and the MCP tool must
 * not be able to disagree about what a token means, and re-expressing the
 * vocabulary per transport is how they would.
 *
 * ⚠️ AN UNRECOGNISED TOKEN IS A REFUSAL, NOT AN IGNORED ONE — returned as
 * `{ unknown }` for the caller to raise in its own error shape. A typo that
 * silently rendered the FULL protocol is exactly the lie this whole story removes:
 * the operator would believe they had switched something off while the agent went
 * on being told to do it. Absent and empty both mean the full protocol, because a
 * client assembling a query string from an optional value should not have to know
 * the difference between omitting a key and sending it blank.
 */
export function parseFindingsPolicy(
  raw: string | null | undefined,
  /**
   * The auto-approve lane (MOTIR-4085), which rides its OWN parameter rather
   * than this token list — deliberately, and the reason is the list's own
   * documented meaning: it is *what this run switches OFF*. A token that turned
   * something ON inside it would make the list two things at once, and the next
   * reader would have to know which tokens go which way. Defaults to `false`, so
   * every existing caller parses to exactly the policy it parsed to before.
   */
  opts: { autoApproveReplan?: boolean } = {},
): { policy: FindingsPolicy; unknown: null } | { policy: null; unknown: string } {
  const autoApproveReplan = opts.autoApproveReplan === true;
  const value = (raw ?? '').trim();
  if (value === '') {
    return { policy: { ...FULL_FINDINGS_POLICY, autoApproveReplan }, unknown: null };
  }

  const disabled = new Set<string>();
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    if (!(FINDINGS_POLICY_TOKENS as readonly string[]).includes(token)) {
      return { policy: null, unknown: token };
    }
    disabled.add(token);
  }
  return {
    policy: {
      logBug: !disabled.has('log-bug'),
      replan: !disabled.has('replan'),
      // ⚠️ CONTRADICTORY BY CONSTRUCTION, so it is resolved here rather than
      // left to each transport: approving a re-plan the agent was told not to
      // submit is not a lane, it is a nonsense. The CLI refuses the two flags
      // together at parse time (`contradictoryReplanFlags`); this is the same
      // rule for every other caller, and it fails to the SAFE side — no lane.
      autoApproveReplan: autoApproveReplan && !disabled.has('replan'),
    },
    unknown: null,
  };
}

/** One confirmed decision as a dispatched prompt renders it (MOTIR-5959). */
export interface ConfirmedDecisionForPrompt {
  key: string;
  title: string;
  /** ISO-8601 — when a person confirmed it: the date the calendar rule compares. */
  decidedAt: string;
  /** The body's `## Decision` section. */
  decisionMd: string;
  /** The body's `## Resulting direction` section — the epic's direction in full. */
  resultingDirectionMd: string;
  /**
   * An AGENT decision approved over a PAGE (MOTIR-7438): the page and the version
   * the approval froze. Its text lives there, not in the card's body, so the two
   * sections above are empty and the prompt names the `get_page` call instead.
   */
  page?: { pageId: string; versionNumber: number };
}

/**
 * One LATEST REFUSAL as the prompt renders it (Story MOTIR-6070 · MOTIR-6422) —
 * `approvalGatesService.latestRefusalFor`'s answer, plus the KEY of the card it hangs
 * on, because a run's leg can be handed its run target's refusal as well as its own.
 */
export interface ChangesRequestedForPrompt extends LatestRefusalDTO {
  key: string;
}

/**
 * A FINISHED neighbour of the dispatched card that carries an OBSOLESCENCE mark
 * (Story MOTIR-6576 · MOTIR-6657) — its parent, one of its blockers, or a work
 * item its `## Context refs` name. Only a finished card can carry a mark
 * (MOTIR-6575), and a dispatched card is always To Do, so the marks a prompt
 * reports sit on these neighbours and never on the card itself.
 */
export interface ObsoleteNeighbour {
  /** Why the card leans on it — the first role wins when it is named twice. */
  role: 'parent' | 'blocker' | 'context ref';
  key: string;
  title: string;
  mark: WorkItemObsolescenceDto;
  /** The keys of the work items that SUPERSEDE it, ascending; `[]` when none is recorded. */
  supersededByKeys: string[];
  /** {@link obsolescenceNoteFirstLine} of its note, or null when it has none. */
  noteFirstLine: string | null;
}

/** The cap on a neighbour's note line — the prompt points at the card, it does not reproduce it. */
export const OBSOLESCENCE_NOTE_LINE_CHARS = 200;

/**
 * The FIRST non-empty line of an obsolescence note, Markdown left as written,
 * capped at {@link OBSOLESCENCE_NOTE_LINE_CHARS} with `…`. `null` for a note that
 * is absent or blank.
 */
export function obsolescenceNoteFirstLine(noteMd: string | null | undefined): string | null {
  const line = (noteMd ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > OBSOLESCENCE_NOTE_LINE_CHARS
    ? `${line.slice(0, OBSOLESCENCE_NOTE_LINE_CHARS)}…`
    : line;
}

/**
 * The run a CONTINUE picks up (Story MOTIR-6526 · MOTIR-6531) — the dead run and
 * where its work is, as the service resolved them. Set only when the prompt is
 * asked for with `continueFrom`; absent, the prompt is a fresh run's.
 */
export interface ContinueFromForPrompt {
  deadRunId: string;
  /** How it ended, in words — `the run stopped reporting (no heartbeat)`, … */
  endedHow: string;
  /** Its last heartbeat, else its end, else its start — ISO-8601. */
  lastHeardAt: string;
  /** Who ran it, or null when that account is gone. */
  dispatcherName: string | null;
  /** The branch its work is on — the one this run checks out. The PRIMARY
   *  repository's, when the run spanned several (`branches[0]`). */
  branch: string;
  /** The open pull request it left, when there is one. */
  pullRequest: { repo: string; number: number; url: string } | null;
  /**
   * Every repository's branch, primary first (MOTIR-6791). Two or more entries
   * render the per-repository CONTINUE block and workflow; one entry (or none,
   * for a caller that predates it) renders exactly the single-branch text.
   */
  branches?: ContinueFromBranch[];
  /**
   * Set when the run did NOT die: it STOPPED AT A GATE (closed `gated`) and is
   * resumed because a gate it stopped on was approved (MOTIR-7708). The prompt
   * then says it is resuming after an approval, never that a run died.
   */
  resume?: {
    /** The gates now approved — the work they released is what to build. */
    approved: { key: string; kind: string }[];
    /** Gates answered "changes requested" (MOTIR-9185): read the reason, redo that work. */
    changesRequested?: { key: string; kind: string }[];
    /** The gates it stopped on that still wait (or were sent back). */
    stillWaiting: { key: string; kind: string; state: string }[];
  } | null;
}

/** One repository's share of a dead run's work, as the CONTINUE prompt names it. */
export interface ContinueFromBranch {
  /** The repository's name, or null when the run did not record it. */
  repository: string | null;
  branch: string;
  pullRequest: { repo: string; number: number; url: string } | null;
}

/** The per-repository branches worth their own rendering — two or more. */
function continueRepoSet(cf: ContinueFromForPrompt): ContinueFromBranch[] | null {
  const branches = cf.branches ?? [];
  return branches.length >= 2 ? branches : null;
}

export interface DispatchPromptSource {
  /** The `PROD-<n>` identifier. */
  key: string;
  title: string;
  kind: WorkItemKindDto;
  type: WorkItemTypeDto | null;
  executor: ExecutorDto | null;
  /**
   * How HARD the work is to reason about (Story MOTIR-6016). Stated in ONE fact
   * line when set; when `null` the prompt says nothing about it at all — no
   * `unset` placeholder, unlike type and executor, so a leaf without one gets
   * exactly the prompt it got before the field existed.
   */
  difficulty: WorkItemDifficultyDto | null;
  priority: WorkItemPriorityDto;
  storyPoints: number | null;
  estimateMinutes: number | null;
  /** The raw Markdown body — partitioned here into narrative / acceptance
   *  criteria / context refs (`splitPlanBody`). */
  descriptionMd: string | null;
  /** The `PROD-<n>` keys of this item's `is_blocked_by` dependencies. */
  blockerKeys: string[];
  /**
   * The OTHER direction (MOTIR-5495): the keys of the open work items that are
   * `blocked_by` THIS item — not archived, status outside the `done` category —
   * ascending. A design card carries the publish step only when this is
   * non-empty, because the server refuses a design result nothing waits on
   * (`designEvidenceService.findWaitingDependentIds`, the one read both use).
   */
  openDependentKeys: string[];
  /**
   * The DESIGNS this card waits on (Story MOTIR-5553 · Subtask MOTIR-5563) —
   * one verdict per work item it is `blocked_by` whose type is `design`,
   * resolved by `designAccessService` and never re-derived here.
   *
   * EMPTY renders nothing at all, which is the ordinary case: most cards wait on
   * no design. It is the ABSENCE that the `code` steps then handle, by telling
   * an agent about to build a rendered surface to go and look.
   */
  designReference?: DesignVerdictDto[];
  /**
   * The CONFIRMED DECISIONS on this card's epic (Story MOTIR-5871 · Subtask
   * MOTIR-5959; ADR `approval-gates.md` §1's MOTIR-5952 amendment, points 9–10) —
   * every `human` decision under the nearest `epic` ancestor whose confirm gate was
   * approved, OLDEST confirmation first. Overturned and awaiting decisions are never
   * here: one governs nothing, the other is not yet agreed.
   *
   * EMPTY renders nothing at all — the normal case, since most epics carry no
   * decision, and a block saying so on every prompt is a block agents skip.
   */
  confirmedDecisions?: ConfirmedDecisionForPrompt[];
  /**
   * The ERRORS linked to this work item (Story MOTIR-5975 · Subtask MOTIR-5982)
   * — every monitor link with its stored facts and evidence, as
   * `monitorIssueService.listForWorkItem` returns them: read from Motir's store,
   * never from the monitor. Omitted or EMPTY renders the prompt byte-identical
   * to one without the field, which is every card that is not a monitor bug.
   */
  errorEvidence?: MonitorIssueLinkDto[];
  /**
   * The organisation's CONTENT LANGUAGE (Story MOTIR-7734 · MOTIR-8745) — the
   * language any work item or to-do the agent writes through Motir is written in.
   * Rendered as the WORK CONTENT LANGUAGE section. Omitted renders nothing, so a
   * caller that does not pass it gets byte-identically the prompt it got before
   * the field existed; a MANUAL item never renders it (no agent writes on it).
   */
  contentLanguage?: Locale;
  /**
   * The LATEST REFUSALS this run must answer (Story MOTIR-6070 · MOTIR-6422; ADR
   * `approval-gates.md` §10h note 4) — for this card, and for its run target when the
   * run was launched against another item — each present only when that card's most
   * recently DECIDED gate, of ANY kind, is `changes_requested`. Rendered as the
   * CHANGES REQUESTED section. Omitted or EMPTY renders nothing: a card nobody sent
   * back gets byte-identically the prompt it got before the field existed.
   */
  changesRequested?: ChangesRequestedForPrompt[];
  /**
   * The MARKED neighbours (Story MOTIR-6576 · MOTIR-6657) — the finished parent,
   * blockers and context-ref work items that carry an obsolescence mark, in the
   * order parent → blockers → context refs, each named once. Omitted or EMPTY
   * renders nothing: an unmarked neighbourhood gets byte-identically the prompt
   * it got before the field existed.
   */
  obsoleteNeighbours?: ObsoleteNeighbour[];
  parent: { key: string; title: string } | null;
  projectName: string;
  /** The project key, e.g. `PROD` — the identifier prefix. */
  projectKey: string;
  /** The RESOLVED target repo (MOTIR-1804), or null when Motir cannot say. */
  targetRepo: string | null;
  /**
   * EVERY repository the item ships in (Story MOTIR-2731 · MOTIR-3132) —
   * ordered, the PRIMARY first, which is the repository the agent's process is
   * launched in. `targetRepos[0]?.name ?? null === targetRepo`, always.
   *
   * Omitted, empty, or of length ONE renders the prompt EXACTLY as it renders
   * today: the multi-repository grammar exists only where a card actually has
   * more than one repository, so every item that exists is unaffected by
   * construction rather than by inspection.
   *
   * The default branch travels WITH the name because the multi-repository blocks
   * branch from `origin/<default>` per repository; the single-repository
   * grammar's hardcoded `origin/main` is left exactly as it is (changing it
   * would move text this card promises not to move).
   */
  targetRepos?: { name: string; defaultBranch: string | null }[];
  /** The inherited session branch, or null for the per-item-PR workflow. */
  sessionBranch: string | null;
  /**
   * The RUN TARGET's key when this item is dispatched as part of a run launched
   * against ANOTHER item — a scoped run's scope (Story MOTIR-4906 · MOTIR-5334).
   * Omitted, null, or equal to {@link key} means this item IS its own run target,
   * so its agent publishes How to test on it. Otherwise the run's close-out step
   * publishes on the target and this agent is told not to.
   */
  runTargetKey?: string | null;
  /**
   * The `likely-missing-edge` PROSE-vs-GRAPH advisories for this item
   * (MOTIR-2079) — items the card's ACCEPTANCE CRITERIA name but that it carries
   * no `blocked_by` edge to. Omitted or empty renders NOTHING (no empty
   * heading), which is the shape almost every card has.
   *
   * ⚠️ NOT a blocker and not a reason to refuse: it is told to the agent so the
   * agent can VERIFY before it branches. See {@link advisorySection}.
   */
  advisories?: WorkItemProseAdvisoryDto[];
  /** The Epic-9 enrichment slots; defaults to {@link NO_INJECTIONS}. */
  injections?: DispatchPromptInjections;
  /**
   * What this run permits the agent to WRITE (MOTIR-3020) — the per-run findings
   * policy, defaulting to {@link FULL_FINDINGS_POLICY} when omitted.
   *
   * ⚠️ IT IS PART OF THE INPUT RECORD, which is what keeps the module's purity
   * claim true rather than merely restated. See the header.
   */
  findingsPolicy?: FindingsPolicy;
  /**
   * The dead run this prompt CONTINUES (MOTIR-6531). When set, the prompt carries
   * the CONTINUE block and a git workflow that checks the dead run's branch out
   * instead of cutting one. Absent for every fresh run.
   */
  continueFrom?: ContinueFromForPrompt | null;
  /**
   * Does the RUNNER that will launch the agent post what the agent writes into
   * `$MOTIR_AGENT_REPORT` as `unbuildable`, `discrepancy` and `stop` (MOTIR-8810)?
   * Only `true` renders those file routes; omitted means NO.
   *
   * ⚠️ NO IS THE DEFAULT BECAUSE THE CLI PEOPLE RUN DID NOT POST. `@motir/cli` 0.12.0
   * sets `$MOTIR_AGENT_REPORT` and reads only `model` from it, so an agent told to
   * put its unbuildable reason there lost it: no report, no planning bug, nothing to
   * tell anyone. The `/api/v1` route passes `true` only when the client DECLARES the
   * capability, which only a CLI that posts all three does. The MCP tool never does:
   * nobody reading a prompt through it is the runner that would post. Without it the
   * prompt routes the report through `report_unbuildable_target` and names neither
   * NO MOTIR TOOLS file route. See {@link agentReportStep}.
   */
  runnerPostsAgentReport?: boolean;
}

/** The assembled prompt plus the workflow variant it ended up carrying. */
export interface AssembledDispatchPrompt {
  prompt: string;
  workflowMode: DispatchWorkflowMode;
  /**
   * The session branch the prompt actually INSTRUCTS — the inherited branch in
   * `session_lineage` mode, else `null`. A MANUAL item is always `null` even when
   * it inherits a lineage: it has no branch and no pull request, so reporting one
   * would tell the CLI to route human work onto a git lineage it will never touch.
   */
  sessionBranch: string | null;
  /**
   * The branch the prompt tells the agent to CREATE for its work (MOTIR-6539) —
   * the SAME name in every repository the item ships in ({@link cardBranch}), or
   * `null` for a MANUAL item, which renders no GIT WORKFLOW and so has no branch.
   *
   * Handed over as a field so a runner can name it before the agent exists and
   * push it as the agent commits, without parsing prose the template may reword.
   * The pull request comes from this branch in `per_item_pr` mode and from
   * {@link sessionBranch} in `session_lineage` mode.
   */
  workBranch: string | null;
  /**
   * The branch the prompt tells the agent to work on (MOTIR-6530) — the session
   * branch in `session_lineage` mode, else the card's own per-item branch
   * ({@link cardBranch}); `null` for a MANUAL item, which has none. It is what a
   * local run records on its leg's `checkout_ready` event, so a run that dies
   * leaves the branch its work is on in the record rather than only in a prompt.
   */
  branch: string | null;
}

/**
 * A placeholder line in a step list, replaced at assembly by
 * {@link conventionStepLines}: the convention read names the card's project and
 * target repository, which a static step list cannot (MOTIR-9084).
 */
const CONVENTION_STEP = '@@CONVENTION_STEP@@';

/**
 * The repository's coding convention is read through the MCP door, not from a file
 * in the checkout (Story MOTIR-9079). A file in the checkout reaches only an agent
 * whose harness auto-loads it, and only in a repository whose owner wrote one; the
 * door reaches every run token and returns the text the team keeps on the Code
 * page. Each fallback is named so an agent does not stall on a missing answer.
 */
function conventionStepLines(src: DispatchPromptSource): string[] {
  const repo = src.targetRepo
    ? `repo: "${src.targetRepo}"`
    : 'repo: <the repository you are working in>';
  return [
    '   BEFORE you build, read the repository’s coding convention and follow it:',
    `   ${GET_CODING_CONVENTION_TOOL_NAME} { projectKey: "${src.projectKey}", ${repo} }`,
    '   If it says no convention is recorded, follow the patterns of the surrounding',
    '   code. If the call fails, say so in your report and follow the surrounding code.',
    '   The repository’s own instruction files may also apply where your harness loads',
    '   them, but this prompt never relies on one.',
  ];
}

/** Replace each {@link CONVENTION_STEP} placeholder with the card's own read. */
function withConventionStep(steps: readonly string[], src: DispatchPromptSource): string[] {
  return steps.flatMap((line) => (line === CONVENTION_STEP ? conventionStepLines(src) : [line]));
}

/**
 * The per-`type` WHAT-TO-DO steps. TOTAL over `WorkItemTypeDto` by construction
 * (`Record<WorkItemTypeDto, …>`), so adding a work-item type without deciding
 * how it dispatches is a COMPILE error here — the same totality guarantee
 * `TOOL_SCOPES` uses for the MCP scope map.
 */
const WHAT_TO_DO: Record<WorkItemTypeDto, string[]> = {
  code: [
    '1. Read the card description above and every file it names under "Context refs".',
    '2. Implement the change.',
    CONVENTION_STEP,
    `   ⚠️ If this change ${RENDERED_SURFACE_TRIGGER}`,
    '   and NO DESIGN REFERENCE is listed in CONTEXT above, do not draw it from',
    `   imagination: look first with the ${LIST_DESIGNS_TOOL_NAME} tool (\`blockersOf\` this`,
    '   card, then the project’s designs by path). If an approved design draws the',
    '   surface, build to it. If nothing does, STOP through THE CARD IS WRONG below and',
    '   ask for a `type: design` card beside this one, with this card blocked_by it.',
    '3. Ship the TESTS that cover the change in the SAME change set: the new logic,',
    '   every new branch, and the error / edge cases. Code without tests is incomplete.',
    '4. Run the repository checks (lint, typecheck, formatting, build) plus the test',
    '   files you added or changed. Do not run the full suite locally — CI runs it.',
    '5. Stop when every acceptance criterion below holds. Do not widen the scope —',
    '   anything else you find is a FOUND A DEFECT, handled in the outcome protocol',
    '   below, which says what to do with it and whether this run may file it.',
  ],
  design: [
    // ⚠️ STEP 1 NAMES THE DESIGN SYSTEM (MOTIR-6963). A project imported with its
    // own component library has none of Motir's tokens, and an unnamed "real design
    // system" was filled with whatever the agent knew best. The three branches are
    // mutually exclusive, and step 1's verdict decides which one a run takes.
    '1. IDENTIFY THE DESIGN SYSTEM before anything else. The project is on Motir',
    '   Design ONLY when BOTH hold: its package.json (the root’s, or the web app’s',
    '   in a monorepo) depends on @motir/design-system, AND its global CSS imports',
    '   @motir/design-system/theme.css. Either check alone is NOT enough. Write the',
    '   files you read and the verdict as the first lines of design-notes.md, then',
    '   follow exactly ONE branch:',
    '   (a) ON MOTIR DESIGN (both checks hold). Read the installed version',
    '       (node_modules/@motir/design-system/package.json, else the lockfile).',
    '       Read the project’s OWN axes from its root layout’s data-style /',
    '       data-palette / data-type (or its DESIGN.md where it has one) — never the',
    '       package defaults unless the project uses them. If that version exports',
    '       @motir/design-system/mock, build the mock with renderMock from the',
    '       package’s parts at those axes; otherwise compose from those parts’',
    '       actual markup with that version’s theme.css inlined. A page that ships',
    '       wider than 64rem is drawn at the width it ships: pass renderMock’s',
    "       boardWidth ('full', or the page’s own max-w-[…] class) where the",
    '       installed version takes it, and never post-process the rendered HTML',
    '       to widen the board. Reach for the',
    '       package’s parts first, then the project’s own local components, then new',
    '       ones. List each part the package lacks in design-notes.md as either',
    '       "proposed addition to @motir/design-system" or "product-local component",',
    '       with a one-line reason.',
    '   (b) ON ITS OWN SYSTEM (either check fails, and the repository has shared',
    '       components or a theme). Build from the repository’s own component',
    '       library and theme — its components directory, its Tailwind config or',
    '       CSS variables, its UI library’s theme — and name those files in',
    '       design-notes.md. Use no --el-* token and no @motir/design-system import.',
    '   (c) NO COHERENT SYSTEM (either check fails, and there are no shared',
    '       components and no theme). BEFORE drawing, write the colours, type sizes',
    '       and spacing the shipped code actually uses into a "## Working palette"',
    '       section of design-notes.md, each with the file it came from, and draw',
    '       with those alone.',
    '   NEVER MIGRATE: in every branch, the design never adds, installs or proposes',
    '   @motir/design-system for a project that does not already use it. A design',
    '   card is not where that decision is made — it is the project owner’s.',
    '2. Read the card description above, then INVENTORY the shipped reality the',
    '   surface lands in — the real routes, shell, and neighbouring design assets.',
    '   Design to FIT what exists; never invent a route, nav, or architecture.',
    '3. RENDER the surface as it ships today (or the real components it composes)',
    '   before drawing anything, and design against that pixel reality.',
    '4. Produce the design asset set for the surface — TWO files, the area’s',
    '   design-notes.md and a <surface>.mock.html — composed from the design system',
    '   step 1 identified, never a raw hex colour or a fixed radius.',
    '   Nothing else: no screenshot export, and no Pencil source.',
    '5. If the surface ALREADY has a design, do not edit its mock. Draw the change',
    '   in a NEW <surface>--<change>.mock.html holding only the panels that change,',
    '   and add a new notes section citing the section and the mock it amends. An',
    '   older mock is a record of its moment, not a specification to keep current.',
    '6. Draw the ACCESS PATH: the affordance in the parent surface that opens this',
    '   one. Naming the route in prose is not enough — the reader must see the door.',
    '7. Stop at the asset. A design is reviewed before anything is built on it.',
  ],
  test: [
    '1. Read the card description above and the behaviour under test.',
    '2. Write the tests it names, against the real dependencies this repository',
    '   uses for tests — not mocks of the thing being verified.',
    CONVENTION_STEP,
    '3. Make each test fail for the right reason first, so it can actually catch the',
    '   regression it claims to cover.',
    '4. Run the test files you added or changed and leave them green.',
  ],
  content: [
    '1. Read the card description above for the audience, surface, and voice.',
    '2. Write the copy to the existing product vocabulary — match the terms the app',
    '   already uses on screen; do not coin a synonym for a shipped term.',
    CONVENTION_STEP,
    '3. Land the copy where the product reads it from (the message catalogue or the',
    '   content file), not inline in a component, and keep every locale in parity.',
  ],
  copy: [
    '1. Read the card description above for the surface, the audience and the voice.',
    '2. Write the strings to the product vocabulary already on screen — match the',
    '   terms the app uses; never coin a synonym for a shipped term.',
    CONVENTION_STEP,
    '3. Land them where the product reads them from (the message catalogue), keyed',
    '   the way its neighbours are — never inline in a component.',
    '4. Every locale the catalogue ships stays in parity: a new key needs its twin',
    '   in each one, or the build has a hole in it.',
  ],
  translate: [
    '1. Read the card description above for the target locale and the source strings.',
    '2. Translate ONLY what already exists — a translation card authors no new',
    '   meaning. If a source string is missing or wrong, say so; do not invent it.',
    CONVENTION_STEP,
    '3. Follow the locale style guide the repository records (register, tone, and',
    '   the glossary of terms that must not be translated).',
    '4. Leave the catalogue at exact key parity with the source locale.',
  ],
  research: [
    '1. Read the card description above for the question being answered.',
    '2. Investigate it against primary sources — the code, the data, the vendor docs',
    '   — and record what you actually verified versus what you inferred.',
    '3. Write the findings up as the deliverable, ending in a recommendation with',
    '   its trade-offs. A research card ships a document, not a code change.',
  ],
  review: [
    '1. Read the card description above for what is being reviewed and against what.',
    '2. Review it end to end, checking correctness first and consistency second.',
    '3. Report findings with a concrete failure scenario each — file and line where',
    '   one applies. A finding without a scenario is an opinion, not a defect.',
  ],
  verification: [
    '1. Read the card description above for the CLAIM to be verified — a stated fact',
    '   about the system, not a deliverable to judge.',
    '2. Verify it where the claim actually lives: pull the artifact from the registry',
    '   its consumer reads, grep the shipped code, read the value back from the',
    '   platform API. A config file in this repository is a claim, not a reading.',
    '3. Record the EVIDENCE — the command you ran and its output — not a verdict on',
    '   its own. "Verified" without the output it came from is an assertion.',
    '4. If the claim is false, say so plainly and log what is actually true. A',
    '   verification that cannot fail has verified nothing.',
  ],
  // ⚠️ THE PUBLISHED PAGE VERSION IS WHAT THE DECISION GATE READS (Story MOTIR-5761 ·
  // MOTIR-7437; `approval-gates.md` §8's NINTH AMENDMENT). It used to be the ONE
  // `docs/decisions/*.md` file the card's pull request carried, captured at its head
  // (MOTIR-5682). Now the record is a PAGE in the card's project: the agent writes
  // it with `create_page` / `update_page`, then `publish_decision_page` SEALS that
  // version and asks the person about exactly it. No branch, no commit, no pull
  // request: the gate has nothing at a PR head to read, and approving it writes
  // `done` itself. A `human` decision card never reaches this lane:
  // `isManualReadyItem` sends it to the manual steps.
  //
  // ⚠️ AND THE PAGE IS THE SUBJECT, NOT THE SCOPE (MOTIR-6194, restated for pages).
  // WHICH page is what the person is asked to approve, so steps 3a/3b are kept:
  // MOTIR-6157's decision was written into the record whose clause it CONTRADICTS
  // rather than the one that OWNS its subject, and then settled a question the card
  // never asked. The runbook's own half of this rule is `motir-meta`
  // `prompts/run.md` step 5b; the two are kept in step because neither side can
  // detect the other's absence.
  decision: [
    '1. Read the card description above for the decision to be made and its',
    '   constraints, and verify each constraint against the shipped code.',
    '2. Lay out the real options with their trade-offs, then DECIDE — a decision card',
    '   ships a decision, not a survey.',
    "3. Record it as ONE PAGE in this card's project, written with the create_page",
    '   tool (or update_page, per 3a). Follow the shape a decision record uses',
    '   (Status → Context → Decision → Consequences), capturing the context, the',
    '   choice, the alternatives rejected, and the consequences. Any repository this',
    '   card pins is CONTEXT for step 1, not the home of the record.',
    '3a. WHICH page — the record goes where its SUBJECT lives, and the page IS what',
    '   the gate asks a person to approve. Name it from the thing being DECIDED, not',
    '   from the text the decision contradicts. DEFAULT to a new page named for the',
    '   decision; update an EXISTING page only when it already OWNS this subject —',
    '   when a reader with this question would open that page to answer it — AND',
    '   only when it is small enough to be READ AS ONE QUESTION. The gate hands the',
    '   reviewer the WHOLE published version, not your edit: a decision buried deep',
    '   in a long page reads as MISSING, because unreadable and absent look the same.',
    '   A decision that contradicts a clause in some OTHER record does not belong in',
    '   that record: it is written where it belongs, and the clause it falsifies is',
    '   cited by name.',
    "3b. HOW MUCH — the record is BOUNDED by this card's own decision. Write what",
    '   this card decided and nothing else. Do not settle a neighbouring question,',
    '   do not retire copy, keys or clauses the card did not name, and do not repair',
    '   what is merely wrong AROUND the part you came to write. Every one of those',
    '   reads as diligence and none of them was approved. Something else wrong in',
    '   that page is a bug to log.',
    '3c. End the record with a "What this does NOT decide" section naming the',
    '   questions a reader could think it settled and it does not. That section is',
    "   what makes the record's scope checkable at the gate instead of inferable.",
    '4. When the page is COMPLETE, call the publish_decision_page tool ONCE with key',
    '   set to this card and pageId set to that page. It seals the version you wrote',
    '   and asks a person to approve exactly it. Do not edit the page afterwards: an',
    '   edit starts a new version, and publishing again replaces the question.',
    '5. Open NO branch, make NO commit, open NO pull request, and link nothing. The',
    '   decision is NOT final when your run ends: a person reads the published',
    '   version in Motir and approves it, and that approval completes the card.',
    '   Stop after the publish.',
  ],
  // A `choice` is a PERSON's pick among options the planner declined to choose
  // between (taxonomy ADR Amendment 3) — its executor defaults to `human`, so
  // `isManualReadyItem` sends it to the manual steps and it is never dispatched.
  // This entry exists because the map is TOTAL and the executor is overridable:
  // an agent handed one anyway is told to stop rather than to pick.
  choice: [
    '1. Stop. This work item is a CHOICE: a person picks one of the options in its',
    '   description, in Motir, and that pick is the whole of the work.',
    '2. Do not choose an option, do not edit the options, and open no pull request.',
    '   If the options look wrong, say so in a comment on the work item.',
  ],
  deploy: [
    '1. Read the card description above for the target environment and the change.',
    '2. Make the pipeline / configuration change, keeping it reproducible in code —',
    '   never a one-off manual mutation of a live environment.',
    '3. State how the change is verified after it lands, and how it is rolled back.',
  ],
  manual: [
    '1. Read the description above — it is the instruction for the person doing this.',
    '2. Perform the steps in the external system it names (a dashboard, a provider',
    '   console, a credential store).',
    '3. Report back what you did and what it produced, so the work items waiting on',
    '   this one can start. Never paste a secret into the work item.',
  ],
  legal: [
    '1. Read the card description above for the legal artifact and the requirement it',
    '   satisfies.',
    '2. DRAFT it — and stop at the draft. This work ends in a signature, and you',
    '   cannot sign: the card defaults to a human executor for that reason.',
    '3. Ground every clause in something real (the requirement, the jurisdiction, the',
    '   product behaviour it describes); flag anything you had to assume.',
    '4. Name who must review and sign it before it is published anywhere.',
  ],
  chore: [
    '1. Read the card description above for the exact maintenance change.',
    '2. Make it mechanically and keep the diff to that change alone.',
    CONVENTION_STEP,
    '3. Run the repository checks and leave everything green.',
  ],
};

/**
 * THE DESIGN-RESULT STEP (MOTIR-5495; `docs/decisions/design-result.md`
 * AMENDMENT 4) — appended to a `type: design` card's steps, and it is one of two
 * texts chosen by the SERVER's answer to *"does an open work item wait on this
 * card?"* ({@link DispatchPromptSource.openDependentKeys}).
 *
 * ⚠️ WHY IT STOPPED BEING UNCONDITIONAL. A publish raises an approval gate, and a
 * gate is only worth a person's time when work is held up by its answer. A design
 * nothing waits on — a design defect fixed in place — is reviewed on its pull
 * request, and the server now REFUSES its result. An agent cannot reliably work
 * out on its own whether anything depends on its card; the server can, from the
 * same read the refusal uses, so the prompt never tells an agent to publish what
 * the server will turn back.
 *
 * ⚠️ AND IT NAMES NO RETIRED INPUT, even to forbid it: naming the screenshot kind
 * or the inline-note argument is how an agent learns they exist. It says which
 * two kinds to send and that nothing else goes.
 */
function designResultSteps(openDependentKeys: readonly string[]): string[] {
  // Numbered directly after the last design step, so adding a design step can
  // never leave the publish step colliding with it (MOTIR-6963).
  const n = WHAT_TO_DO.design.filter((line) => /^\d+\. /.test(line)).length + 1;
  if (openDependentKeys.length === 0) {
    return [
      `${n}. Do NOT publish a design result. No open work item is blocked_by this card,`,
      '   so nothing waits on this design: its pull request is its review, and',
      '   publish_design_result would refuse the call.',
    ];
  }
  return [
    `${n}. PUBLISH the design result — ${openDependentKeys.join(', ')} ${
      openDependentKeys.length === 1 ? 'is' : 'are'
    } blocked_by this card, so`,
    '   work waits on this design. Commit both files, then call the',
    '   publish_design_result tool with this card’s key and exactly these assets:',
    '   each *.mock.html you drew as kind "mock" (for a change, only the new delta',
    '   mock), and the area’s design-notes.md as the one kind "note_file". Send',
    '   nothing else — the result shows the mock, with the note one link away. Do',
    '   this in the SAME iteration that produced the asset, while the files are in',
    '   front of you.',
    '',
    '   THE PUBLISHED RESULT IS THE SOURCE OF TRUTH (design-result.md AMENDMENT 5',
    '   Q1). It is what every later run is handed and what a reviewer decides on.',
    '   Committing the two files to the repository is OPTIONAL — useful where the',
    '   team keeps its designs beside the code, and never the authority. Where a',
    '   committed copy and the published result differ, the published result is',
    '   the design.',
    '',
    '   And nothing else will make this call. A design card whose result never',
    '   arrives looks exactly like one that succeeded — files written, commit',
    '   landed, checks green, card empty — so the publish is a step of this run,',
    '   not something to confirm afterwards. The call returns the evidence id:',
    '   report it, and report that the card now awaits a person’s approval.',
    '',
    '   An area note routinely runs to hundreds of kilobytes, and you cannot emit',
    '   that much base64 as a tool argument. For any file over roughly a megabyte,',
    '   call create_design_upload with this card’s key and one entry per file, PUT',
    '   each file’s bytes to the uploadUrl it returns',
    '   (curl -X PUT --upload-file <file> -H "Content-Type: <type>" "<url>"),',
    '   and then send each grant’s pathname to publish_design_result instead of',
    '   contentBase64. One publish uses one form for all of its assets.',
    '',
    '   WHAT A PUBLISH STARTS, AND WHAT IT DOES NOT DO:',
    '   - Publishing raises an approval gate on this card. A person decides it;',
    '     you never approve it and have no way to.',
    '   - A card with an open pull request holds two gates and asks ONE question:',
    '     the design gate is the primary, and one Approve decides both. Approve',
    '     moves the card to done only when no pull request is open; with one open,',
    '     the merge is what writes done.',
    '   - Your publish does NOT release a blocked_by on this card. Readiness reads',
    '     done, so work that waits on this design continues after the approval or',
    '     the merge, never after your commit.',
    '   - Republish only because the design CHANGED. A second publish retires the',
    '     pending question, so a reviewer mid-review loses it. Never republish to',
    '     refresh.',
    '   - A superseded design’s missing files are expected: a version that was sent',
    '     back loses its bytes on the ordinary sweep. It is not a defect.',
  ];
}

/**
 * THE ACCEPTANCE-RECEIPT STEPS (bug MOTIR-4704) — appended to a `type: test`
 * card's steps when, and only when, the card is the one that records a story's
 * acceptance video.
 *
 * ⚠️ WHY THIS IS CONDITIONAL. `type: test` is every test card there is, and the overwhelming
 * majority are ordinary regression work that must NOT be told to publish a
 * receipt — an instruction to publish something the run never recorded is worse
 * than silence, because the agent will go looking for a recording to satisfy it.
 * So the steps live here and are appended by {@link recordsAcceptanceReceipt},
 * following the conditional-advisory shape the design-gate and subsumption
 * blocks already use, rather than widening the unconditional list.
 *
 * WHAT THIS FIXES. MOTIR-4096 retired the CI uploader and said "the agent
 * publishes it" — but nothing in the product ever asked the agent to. The
 * instruction reached the run only as prose the planner had written into the
 * card body, so the runner's own dispatch prompt, which is the one thing it
 * cannot skip reading, said nothing about the deliverable the card exists to
 * produce. A design run is told by Motir; an acceptance run was told by
 * whoever wrote the card.
 *
 * WHO PUBLISHES, SINCE 2026-10-01 (MOTIR-7253 / MOTIR-7254). CI publishes the
 * receipt again in the repositories whose acceptance lane carries the uploader —
 * motir-core, and every project generated from the starter
 * (`docs/decisions/acceptance-video.md`, the 2026-10-01 amendment). The prompt
 * cannot see a repository's workflows, but the agent is standing in a checkout
 * of it, so the decision is a READ of that checkout: step 5 below greps
 * `.github/workflows/` for the `upload-acceptance-video` action. Where it
 * matches, the agent makes no MCP publish and says so; anywhere else it
 * publishes exactly as before. The stand-down is a named BRANCH, never a
 * softened instruction — wording an agent in a repository with no publishing
 * lane could read as "skip publishing" would bring back the silent missing
 * receipt MOTIR-4704 ended. Exported so the test pins the check verbatim.
 */
export const ACCEPTANCE_LANE_PUBLISHES_CHECK =
  "grep -rlE 'uses:\\s*\\./\\.github/actions/upload-acceptance-video' .github/workflows/";

const ACCEPTANCE_PUBLISH_STEPS = [
  '5. FIRST, find out WHO publishes the receipt in this repository. From the',
  '   root of your checkout run:',
  '',
  `       ${ACCEPTANCE_LANE_PUBLISHES_CHECK}`,
  '',
  '   IF IT PRINTS A FILE, this repository’s acceptance lane publishes the',
  '   receipt itself, from a green pull-request run, over keyless OIDC. Make NO',
  '   MCP publish — do not call create_acceptance_upload or',
  '   publish_acceptance_result. Confirm your spec declares its story with',
  '   `acceptanceStory()` (without it the lane cannot attribute the clip), push,',
  '   and write in your run report: “this repository’s acceptance lane publishes',
  '   the receipt on a green run; no MCP publish made”. Steps 6 and 7 do not',
  '   apply.',
  '',
  '   IF IT PRINTS NOTHING, no lane here publishes, and steps 6 and 7 are yours.',
  '6. OTHERWISE, PUBLISH the receipt, from THIS run, while the recording is in',
  '   front of you. Two calls, because a video is far larger than a tool',
  '   argument can carry: `create_acceptance_upload` with this card’s key mints',
  '   a short-lived presigned PUT; upload the clip’s bytes straight to that URL',
  '   with `Content-Type: video/webm`; then `publish_acceptance_result` with the',
  '   `pathname` it gave you, the chapters from `chapters.json`, the `commitSha`',
  '   you recorded at, and this card’s key as `producedByKey`. Pass this card’s',
  '   key to both — a receipt belongs to the STORY, and the server resolves up.',
  '7. Confirm it landed. The call returns the receipt’s `id` and a `pending`',
  '   status; report the id, because that is what makes the publish checkable by',
  '   somebody else.',
  '',
  '   WHERE NO LANE PUBLISHES, NOTHING ELSE MAKES THAT CALL. A story whose',
  '   receipt never arrives looks exactly like one that succeeded — spec green,',
  '   checks green, pull request merged, and a story nobody can watch working. A',
  '   red run publishes nothing, and that is correct: the receipt records a GREEN',
  '   run or it records nothing.',
  '',
  '   AN ACCEPTANCE SPEC IS A RECEIPT, NOT A REGRESSION TEST:',
  '   - It records ONE watchable run of a story working, which a person then',
  '     approves. Approving pins the recording; it does not freeze the story. To',
  '     record again, the story goes back below implemented.',
  '   - Only the spec’s AUTHOR moves it out of the acceptance lane, by promoting',
  '     it into a lane that runs on every pull request or by retiring it. A signed',
  '     receipt never moves it.',
  '   - If an acceptance spec goes red on a pull request that did not change its',
  '     story, do NOT edit the assertion to match today. That rewrites history to',
  '     agree with the present. Give it a disposition (promote or retire) and',
  '     say which.',
];

/**
 * Whether this card is the one that records a story's acceptance video.
 *
 * Read off the card's own text rather than a field, because there is no field:
 * what makes a test card an acceptance card is that its spec calls
 * `acceptanceStory()` and lands in the acceptance lane, and the planner states
 * that in the body it writes (motir-meta `plan-rules/kind-story.md` — every
 * user-facing story carries an E2E subtask that "records + publishes a short
 * acceptance VIDEO"). Both halves of the card are searched, since some cards
 * carry the intent only in the title.
 *
 * Deliberately NARROW. A false negative costs the run a prompt it can still get
 * from the card body it was handed; a false positive tells an ordinary
 * regression card to publish a recording that does not exist.
 */
export function recordsAcceptanceReceipt(src: {
  type: WorkItemTypeDto | null;
  title: string;
  descriptionMd: string | null;
}): boolean {
  if (src.type !== 'test') return false;
  const text = `${src.title}\n${src.descriptionMd ?? ''}`;
  return /acceptanceStory\s*\(|acceptance\s+(video|receipt)/i.test(text);
}

/**
 * The REPRODUCTION preamble for a BUG card (MOTIR-5944) — chosen by `kind`, not
 * `type`, and PREPENDED to whichever steps the type selected.
 *
 * WHY IT EXISTS. A bug card is the one card whose premise can be false while the
 * defect is real: somebody saw something fail. Without this block the only exit
 * a non-reproducing premise meets is THE CARD IS WRONG, whose first step is to
 * REVERT — so a clean probe routed an agent straight to "premise false" without
 * ever asking whether the code moved since the report, or varying a condition
 * the card did not name (MOTIR-2994: the defect was one untried condition away).
 * This is the runbook's *a bug card's FIRST deliverable is the REPRODUCTION*
 * rule (motir-meta `run.md`), in the one document a dispatched agent reads.
 *
 * ⚠️ ORDER IS THE POINT: it renders in WHAT TO DO, which precedes the outcome
 * protocol, so it is read before the exit it gates. After the exit it would
 * never be reached. Lettered, not numbered, so it does not collide with the
 * type's own step 1.
 */
const BUG_REPRODUCTION_STEPS = [
  'THIS IS A BUG CARD. Before step 1, REPRODUCE THE DEFECT — and do it before you',
  'decide the card is wrong. A report that will not reproduce is not yet a false',
  'premise:',
  '',
  'a. Reproduce at the REPORTER’S BASE, not at HEAD: the branch or commit the card',
  '   names (if it names none, the last main commit before the card was filed),',
  '   with the data setup and the screen, endpoint or command the card names.',
  'b. It will not reproduce? One command separates two opposite findings:',
  '   `git log <reporter’s base>..HEAD -- <the paths that serve it>`. Empty means',
  '   nothing changed, so it was NEVER reproduced; non-empty means read those',
  '   commits first — it may have been fixed in between.',
  'c. A non-reproduction obliges the MATRIX, not the verdict. List the conditions',
  '   the card’s premise holds fixed (timing, concurrency, input shape, empty vs',
  '   populated, a missing or unresolvable value, …) and VARY each one. A passing',
  '   condition measures only that condition. Put the results table — passing rows',
  '   included — in the pull request body, and do not report the defect as absent',
  '   while the original observation is unexplained. "Widened to N conditions,',
  '   still unexplained" is an honest result.',
  'd. Only after a–c may a falsified premise go to THE CARD IS WRONG below.',
  '',
];

/** WHAT TO DO for an item with no `type` set — the card body is all we have. */
const UNTYPED_WHAT_TO_DO = [
  '1. Read the card description above; it is the specification for this work.',
  '2. Do exactly what it asks.',
  CONVENTION_STEP,
  '3. Stop when every acceptance criterion below holds.',
  '',
  'NOTE: this work item has no `type` set, so these steps are the generic form.',
  'Setting a type (code / design / test / …) yields step-by-step guidance for it.',
];

/** The human-instruction WHAT TO DO — a manual item is done by a person. */
const MANUAL_WHAT_TO_DO = WHAT_TO_DO.manual;

/** Title-case a kind/type/priority enum value for prose (`in_progress` → `In progress`). */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A branch-name slug from the item's title: lower-cased, non-alphanumerics
 * collapsed to single dashes, trimmed, and capped so the branch stays readable.
 * Deterministic — the same title always yields the same slug.
 */
export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'work';
}

/**
 * The branch PREFIX, chosen by what the diff will actually touch — the rule
 * `motir-meta/prompts/run.md` states as "prefix by DIFF content, not card type":
 * a design-asset-only diff uses `design/`, a docs-only diff `docs/`, and both
 * let CI skip the end-to-end legs that cannot be affected by them.
 */
function branchPrefix(type: WorkItemTypeDto | null): string {
  if (type === 'design') return 'design';
  // A `decision` card takes no branch at all (MOTIR-7437): it writes a page.
  if (type === 'research') return 'docs';
  return 'subtask';
}

/** The worktree directory the GIT WORKFLOW suggests — repo-qualified when Motir
 *  knows the repo, generic when it does not. */
function worktreeDir(targetRepo: string | null, key: string): string {
  return `../${targetRepo ?? '<repo>'}-${key.toLowerCase()}`;
}

/** A `KEY — Title` reference line, used for the parent. */
function refLine(ref: { key: string; title: string }): string {
  return `${ref.key} — ${ref.title}`;
}

/** Wrap a body in the rule-barred section heading every section shares. */
function section(heading: string, lines: string[]): string[] {
  return [RULE, heading, RULE, ...lines];
}

/**
 * The PROSE-vs-GRAPH advisory block (MOTIR-2079) — the CONTEXT lines that tell
 * the agent which items this card's acceptance criteria NAME but carry no
 * `blocked_by` edge to, and what to do about each.
 *
 * Why the prompt and not just the CLI: the CLI never assembles prompt text, so a
 * warning printed only there reaches one harness. Rendering it HERE means every
 * harness — Claude Code, Codex, opencode, a human reading the printed prompt —
 * inherits it, because none of them writes its own prompt.
 *
 * The instruction is VERIFY, never REFUSE. A `likely-missing-edge` is a strong
 * hint and not a fact: a boundary-contract card legitimately names both halves
 * of a two-PR split, an acceptance criterion legitimately names a card for
 * contrast, and a sibling may simply be done before this item is dispatched. The
 * agent is the one standing where the check is cheap (`git ls-tree origin/main`)
 * and is told to make it — which is exactly the step that has been skipped.
 *
 * Empty in, nothing out: no heading, no blank line, no trace.
 */
function advisorySection(advisories: WorkItemProseAdvisoryDto[]): string[] {
  if (advisories.length === 0) return [];
  const references = advisories.filter(isReferenceAdvisory);
  const shapes = advisories.filter(isOrderingAdvisory);
  const straddles = advisories.filter(isRepoStraddleAdvisory);
  const subsumed = advisories.filter(isSubsumptionAdvisory);
  const oversized = advisories.filter(isSizingAdvisory);
  const selfBlocking = advisories.filter(isSelfBlockingDesignAdvisory);
  const bodyAbove = advisories.filter(isBodyAboveFieldMoveAdvisory);
  const blockerCounts = advisories.filter(isBlockerCountAdvisory);
  const underAuthored = advisories.filter(isUnderAuthoredAdvisory);
  const lines: string[] = [];

  if (underAuthored.length > 0) {
    lines.push(
      '',
      'THIS CARD IS UNDER-AUTHORED — no acceptance criteria and no sizing, type or executor:',
      '  There is no list of criteria to build to. Work out what "done" means from the description',
      '  and the repository, state your reading in the pull request, and proceed. This is not a',
      '  reason to stop; the card needs authoring afterwards, not before you start.',
    );
  }

  if (blockerCounts.length > 0) {
    lines.push(
      '',
      "A COUNTED CLAIM ABOUT THIS CARD'S BLOCKERS DISAGREES WITH THE GRAPH:",
      ...blockerCounts.map(
        (a) =>
          `    - "${a.claim}" says ${a.claimedCount}; the graph holds ${a.blockerCount} blocked_by edge${a.blockerCount === 1 ? '' : 's'}.`,
      ),
      '  Check which side is stale before relying on the prose. Update the card body when the',
      '  graph is authoritative; wire the missing edge when the dependency is real.',
    );
  }

  if (references.length > 0) {
    lines.push(
      '',
      'REFERENCED BUT NOT A DEPENDENCY — verify these before you branch:',
      ...references.map(
        (a) =>
          `    - ${a.referenced} (${a.referencedStatus}) is named in this card's acceptance` +
          ` criteria, but this item carries no blocked_by edge to it.`,
      ),
      '  For each one, confirm the substrate it provides is already on origin/main',
      '  (git ls-tree / git grep origin/main for the file, symbol or test the criterion',
      '  names). If it lives ONLY on an open pull request, this item is blocked in fact:',
      '  wire the blocked_by edge and STOP. Do not rebuild the other half yourself and do',
      '  not stack onto the unmerged branch — two green pull requests whose composition',
      '  turns main red is the recurring failure this warning exists to prevent.',
    );
  }

  // The ORDERING advisory (MOTIR-2175). Addressed to the agent because the agent
  // is the party the defect lands on: its two moves are to stop with the card
  // half-done or to fake the precondition (tag a pre-merge commit, publish from
  // an unmerged tree), and both are rule violations. Naming the criterion index
  // is what makes the third move — cut the card here — available.
  if (shapes.length > 0) {
    lines.push(
      '',
      "A CRITERION THAT TURNS ON THIS CARD'S OWN MERGE — read this before you start:",
      ...shapes.map(
        (a) =>
          `    - acceptance criterion ${a.criterionIndex} says "${a.phrase}", which is state` +
          ` that exists only after this card's pull request has MERGED.`,
      ),
      '  Your boundary ends at PR opened: this repo merges manually, and the merge is',
      "  the human reviewer's. So that criterion — and every criterion below it, which",
      '  inherits the same dependency — belongs to a follow-on card blocked_by this one.',
      '  Do NOT fake the precondition (no tagging a pre-merge commit, no publishing from',
      '  an unmerged tree) and do NOT silently drop the criterion. Build everything ABOVE',
      '  the line, then report the split so the remainder can be carded (plan-rules.md,',
      '  gate 14, ORDERING axis).',
    );
  }

  // The REPO-STRADDLE advisory (MOTIR-2177). Addressed to the agent for the same
  // reason: it is about to create ONE worktree in ONE repo, and a criterion
  // discharged in another repo is one it physically cannot satisfy from there.
  // Naming the PATH is what makes the finding checkable in a second rather than
  // taken on faith — and checkable is what it needs to be, because a
  // boundary-contract card fires here legitimately.
  if (straddles.length > 0) {
    lines.push(
      '',
      'A CRITERION DISCHARGED IN ANOTHER REPO — read this before you branch:',
      ...straddles.map((a) =>
        a.reason === 'contradiction'
          ? `    - acceptance criterion ${a.criterionIndex} names ${a.path}, which lives in` +
            ` ${a.repo} — not this card's pinned repo.`
          : `    - acceptance criterion ${a.criterionIndex} names ${a.path} (${a.repo}), and this` +
            ' card pins no repo while its criteria name more than one.',
      ),
      '  ONE SUBTASK = ONE REPO = ONE PR: one worktree, one pull request, so a criterion',
      "  discharged outside this card's repo cannot be satisfied inside it. CHECK IT FIRST —",
      "  if the other repo's half is already merged, or this is a boundary-contract card whose",
      '  own body pins the producer/mirror split (two coordinated PRs, one card), the finding',
      '  is a known false positive and you proceed. Otherwise do NOT silently pick one repo and',
      "  drop the other's criteria: that is run.md guard #5 — surface the split and STOP.",
    );
  }

  // THE ESTIMATION GATE (MOTIR-3110). Addressed to the agent because the agent
  // is where the cost lands, and it goes in the prompt rather than only in the
  // tool summary because the prompt is the one surface every harness inherits.
  //
  // ⚠️ IT NEVER STOPS THE RUN (MOTIR-5372, docs/decisions/over-gate-sizing-never-stops-a-run.md).
  // This block used to say "Propose the split and STOP". A size is an estimate,
  // and a card stuck on a sizing reason is a dead end for a non-technical user,
  // while a large pull request is recoverable. So the agent is told the card is
  // over the gate, told to say so in its report, and told to build it.
  if (oversized.length > 0) {
    lines.push(
      '',
      'THIS CARD IS SIZED PAST THE ESTIMATION GATE — build it anyway, and say so in your report:',
      ...oversized.map(
        (a) =>
          `    - ${a.storyPoints ?? '—'} story points / ${a.estimateMinutes ?? '—'} estimated` +
          ` minutes, over ${a.threshold === 'both' ? 'BOTH ceilings' : a.threshold === 'story_points' ? 'the 8-point split signal' : 'the 70-minute estimate threshold'}.`,
      ),
      '  This is a WARNING, never a reason to stop: do NOT halt the run, propose a split',
      '  instead of building, or hand the card back. Build every acceptance criterion as usual.',
      '  In your final report (and the PR description), state that the card was sized over the',
      '  estimation gate, with the numbers above, so a planner can size similar work smaller',
      '  next time. If the numbers are plainly wrong for what the card asks, you may correct',
      '  them on the record as well.',
    );
  }

  // THE DESIGN GATE (MOTIR-3178). Addressed to the agent because the agent is the
  // one holding both halves: the card in its hand asks it to draw a design and
  // then build the files that match it, in one pull request, with nobody looking
  // in between. That is Principle #13 exactly inverted, and the agent is the last
  // point at which it is still cheap to say so.
  if (selfBlocking.length > 0) {
    lines.push(
      '',
      'THIS CARD IS ITS OWN DESIGN BLOCKER — it draws the design AND builds it:',
      ...selfBlocking.map(
        (a) =>
          `    - criterion ${a.designCriterionIndex} produces a design asset; criterion ` +
          `${a.surfaceCriterionIndex} builds a rendered surface against it.`,
      ),
      '  Design before code, WITHIN every story (Principle #13) means somebody sees the drawing',
      '  before the files written to match it. Read literally the design gate is satisfied here —',
      '  the type: design subtask this card must be linked to IS this card — which is exactly the',
      '  reading this check exists to catch. The remedy is a LIFT, not a cut: propose the design',
      '  criterion as its OWN type: design card, leave the rest blocked_by it, and STOP. Do not',
      '  draw and build in one pass. If the composition is genuinely right — the asset is a small',
      '  amendment nobody needs to approve separately — say so on the record and proceed.',
    );
  }

  // THE BODY-EDIT-ABOVE-FIELD-MOVE finding (MOTIR-5399). Addressed to the agent
  // because the agent is the first party that can notice: MOTIR-4513's fields said
  // `content` and its body, rewritten after them, said `decision`, and every
  // channel above reported the card healthy until the run built on it and stopped.
  // A prompt to re-read — the trail cannot tell a revert from a matching rewrite —
  // so it never tells the agent to stop, only where to look.
  if (bodyAbove.length > 0) {
    lines.push(
      '',
      "THIS CARD'S BODY WAS WRITTEN AFTER ITS FIELDS LAST MOVED — read both before you start:",
      ...bodyAbove.map((a) => `    - ${describeBodyAboveFieldMove(a)}.`),
      '  Re-read the description and explanation against the fields that write moved (the',
      '  card header above shows their current values). A body rewritten to MATCH the move is',
      '  the ordinary correction: proceed. If the body instead describes the card as it was',
      "  BEFORE the move — another type, another executor, another repo — the card's fields and",
      '  prose disagree: build to the FIELDS, which are what dispatch, review and the ready set',
      '  read, and name in your report the sentences of the body that contradict them.',
    );
  }

  // The SUBSUMPTION advisory (MOTIR-2903). Addressed to the agent because the
  // agent is the one about to spend a session rebuilding something that is
  // already on `main` — a rebuild that is green in isolation, conflicts with
  // nothing, and ends with a second mechanism for a problem that already has
  // one. The remedy is a diff to READ, so the pull request is named rather than
  // the finding merely asserted.
  if (subsumed.length > 0) {
    lines.push(
      '',
      'THIS CARD MAY ALREADY BE BUILT — read the diff before you write a line:',
      ...subsumed.map(
        (a) =>
          `    - ${a.path}, which this card's body names, was changed by ${a.pullRequest}` +
          ` (merged ${a.mergedAt}${a.pullRequestTitle ? ` — "${a.pullRequestTitle}"` : ''}),` +
          ' after this card was filed.',
      ),
      "  A card is not closed when the work that satisfies it merges under someone else's",
      '  key, so a card whose deliverable already shipped still reads ready, still ranks',
      "  high, and still gets claimed. READ that pull request against this card's",
      '  acceptance criteria. If it already delivers them, STOP: close the card with the',
      '  merge as the evidence and report it — do not rebuild merged work. If the two',
      '  merely touch the same file, which is the ordinary case, proceed normally.',
    );
  }
  return lines;
}

/**
 * The DESIGN REFERENCE block (Story MOTIR-5553 · Subtask MOTIR-5563) — what this
 * card is supposed to be built against, and what to do when there is nothing.
 *
 * ⚠️ IT RENDERS FOR EVERY TYPE, not only for UI code. A design decides more than
 * pixels: which element owns which behaviour, what a surface is allowed to
 * assume. A service card whose design blocker moved is as wrong as a component
 * card, and it is the one least likely to go looking.
 *
 * ⚠️ AND AN EMPTY LIST RENDERS NOTHING. Most cards wait on no design, and a
 * block saying so on every one of them is a block agents learn to skip — which
 * is exactly the block that must be read on the cards that do have one. The
 * ABSENCE is handled where it bites instead, in the `code` steps.
 */
function designReferenceSection(verdicts: readonly DesignVerdictDto[]): string[] {
  // ⚠️ A `not_a_design_card` VERDICT IS DROPPED HERE, and the asymmetry with the
  // service is deliberate. `designAccessService` answers for EVERY blocker,
  // including the ones that are not design cards, because an API caller asking
  // *what designs does this card wait on* is entitled to be told that a blocker
  // it expected to be a design is not one. An AGENT is not: almost every card
  // has a non-design blocker, so rendering those would put a DESIGN REFERENCE
  // block on almost every prompt, filled with lines saying nothing — and a block
  // that is usually noise is a block agents learn to skip, which is exactly the
  // block that must be read on the cards that do have a design.
  const relevant = verdicts.filter(
    (v) => v.verdict === 'approved' || v.reason !== 'not_a_design_card',
  );
  if (relevant.length === 0) return [];

  const lines: string[] = ['', 'DESIGN REFERENCE — what this card is built against'];
  const approved = relevant.filter((v) => v.verdict === 'approved');
  const refused = relevant.filter((v) => v.verdict !== 'approved');

  for (const verdict of approved) {
    if (verdict.verdict !== 'approved') continue;
    const { design } = verdict;
    lines.push(
      '',
      `  ${verdict.designCardKey} — ${verdict.designCardTitle}`,
      `    APPROVED, version ${design.evidenceId}`,
    );
    for (const asset of design.assets) {
      lines.push(
        asset.state === 'available'
          ? `      ${asset.kind}  ${asset.sourcePath}`
          : `      ${asset.kind}  ${asset.sourcePath}  (UNAVAILABLE — this approved ` +
              'version’s files were reclaimed; it is still the approved design)',
      );
    }
    lines.push(
      `    WHERE THE FILES ARE: if $${DESIGN_DIR_ENV} is set in your environment, they are`,
      `    already on disk at $${DESIGN_DIR_ENV}/${verdict.designCardKey}/<sourcePath>. If it is`,
      `    NOT set, fetch them NOW with the ${GET_DESIGN_TOOL_NAME} tool on`,
      `    ${verdict.designCardKey} — its links expire within minutes, so download them before`,
      '    you read or plan anything, into a directory OUTSIDE the repository checkout so',
      '    the design never lands in your diff.',
    );
  }

  if (approved.length > 0) {
    lines.push(
      '',
      '  HOW TO READ A MOCK. Open the *.mock.html SOURCE, not a rendering of it, and',
      '  read EVERY panel: a mock is usually a multi-panel board (closed vs open, empty',
      '  vs populated), and a single view hides elements the source names. A file whose',
      '  name carries `--` is a DELTA mock: it holds only what CHANGED about an earlier',
      '  surface, and its note section names the mock it amends — fetch that base with',
      `  ${LIST_DESIGNS_TOOL_NAME} using its path as \`pathPrefix\`, and read both.`,
    );
  }

  for (const verdict of refused) {
    if (verdict.verdict !== 'not_approved') continue;
    lines.push(
      '',
      `  ${verdict.designCardKey} — ${verdict.designCardTitle}`,
      `    NO APPROVED DESIGN (${verdict.reason}). This card waits on that design card,`,
      '    and it has no approved result to build against.',
    );
  }

  lines.push(
    '',
    '  ⚠️ THE DESIGN GATE — CHECK IT BEFORE YOU BUILD ANYTHING VISIBLE.',
    '  Your blockers being done means the design CARD is finished. It does not mean a',
    '  design exists, and it does not mean the design draws what you have to build. So',
    '  look, and STOP in either of these two cases:',
    '',
    '    (a) any design above is NOT approved; or',
    '    (b) you must build an ELEMENT no approved design draws — a whole panel,',
    '        control, section or screen. An unspecified DETAIL is not this: a hover',
    '        tint, a focus ring, an obvious empty-state string are yours to decide from',
    '        the design system. A piece of UI nobody drew is not.',
    '',
    '  In either case do NOT build it and do NOT draw it yourself. Stop through THE CARD',
    '  IS WRONG below, and ask for a NEW `type: design` card placed BESIDE this card —',
    '  the same parent, never a child of it — that `relates_to` the design card(s) named',
    '  above, with this card `blocked_by` it. The old design card stays done: it is the',
    '  record of what was decided, not a slot to overwrite.',
  );
  return lines;
}

/** The CONTEXT section's fact lines + the card's narrative body. */
function contextSection(
  src: DispatchPromptSource,
  narrative: string,
  contextRefs: string[],
  injections: DispatchPromptInjections,
): string[] {
  const facts: string[] = [
    `- Project: ${src.projectName} (${src.projectKey})`,
    `- Work item: ${src.key} · ${humanize(src.kind)} · type ${src.type ?? 'unset'} · executor ${
      src.executor ?? 'unset'
    } · priority ${src.priority}`,
  ];

  const sizing: string[] = [];
  if (src.storyPoints !== null) sizing.push(`${src.storyPoints} story points`);
  if (src.estimateMinutes !== null) sizing.push(`~${src.estimateMinutes} min`);
  if (sizing.length > 0) facts.push(`- Sizing: ${sizing.join(' · ')}`);
  // Named as REASONING, not size, so an agent does not read `high` as "big".
  if (src.difficulty !== null) {
    facts.push(`- Difficulty: ${src.difficulty} — the reasoning this work demands, not its size`);
  }

  const repoSet = multiRepoSet(src);
  if (repoSet) {
    // MOTIR-3132 — the agent is standing in ONE checkout and owes work in all of
    // them, so the set is named here rather than left to be discovered in the
    // GIT WORKFLOW section. The paths are the CLI's `<root>/<name>` convention
    // and are stated as an expectation, never as a fact: this text is assembled
    // server-side and cannot know where a person keeps their checkouts. The run
    // resolves and prints the real ones (MOTIR-3133).
    facts.push(`- Repositories (${repoSet.length}) — this item ships in EVERY one of them:`);
    repoSet.forEach((repo, i) => {
      facts.push(
        i === 0
          ? `    - ${repo.name} — the PRIMARY, and your working directory.`
          : `    - ${repo.name} — expected as a sibling of it, at ../${repo.name}.`,
      );
    });
    facts.push(
      '    The run names each repository\u2019s actual resolved path before you start. If one',
      '    is missing or elsewhere, say so in your outcome report — do not work around it.',
    );
  } else {
    facts.push(
      src.targetRepo
        ? `- Repo: ${src.targetRepo} — do the work in this repository's checkout.`
        : '- Repo: not pinned. Motir cannot say which repository this item belongs to;' +
            ' work in the checkout you were invoked from.',
    );
  }
  facts.push(src.parent ? `- Parent: ${refLine(src.parent)}` : '- Parent: none (top-level item)');
  facts.push(
    src.blockerKeys.length > 0
      ? `- Depends on (already landed): ${src.blockerKeys.join(', ')}`
      : '- Depends on: nothing — this item stands alone.',
  );

  if (contextRefs.length > 0) {
    facts.push('- Context refs — READ these before you start:');
    for (const ref of contextRefs) facts.push(`    - ${ref}`);
  } else {
    facts.push('- Context refs: none named on the card.');
  }
  facts.push(...obsoleteNeighbourLines(src.obsoleteNeighbours ?? []));

  // The Epic-9 enrichment slots (empty in motir-core — see the module header).
  for (const block of injections.lessons) facts.push('', block);

  // Sibling to the lessons slot, and for the same reason: something the agent
  // must know BEFORE it starts, not something it would find in the card body.
  facts.push(...advisorySection(src.advisories ?? []));

  // The DESIGN this card is built against (MOTIR-5563) — beside the advisories
  // and for the same reason: something the agent must know BEFORE it starts,
  // not something it would find by reading the card body.
  facts.push(...designReferenceSection(src.designReference ?? []));

  // The epic's CONFIRMED DECISIONS and the calendar rule (MOTIR-5959) — beside the
  // design reference and for the same reason: the direction the work was agreed to
  // take is something the agent must know BEFORE it starts.
  facts.push(...confirmedDecisionsSection(src.confirmedDecisions ?? []));

  // The REASON the last attempt was sent back (MOTIR-6422) — the last gate-derived
  // block, directly above the card body it changes how to read.
  facts.push(...changesRequestedSection(src.changesRequested ?? []));

  // THE RUN THIS ONE CONTINUES (MOTIR-6531) — beside the refusal and for the same
  // reason: the story of a previous attempt, read before the card body.
  facts.push(...continueSection(src.continueFrom ?? null));

  facts.push('', 'CARD DESCRIPTION');
  facts.push('', narrative.length > 0 ? narrative : '(The card carries no description body.)');
  return facts;
}

/**
 * One CONTEXT line per MARKED neighbour (MOTIR-6657) — the mark, what superseded
 * it and the first line of its note — then ONE line saying how to read each mark.
 * Sits directly under the context refs because it changes how the agent reads
 * them. EMPTY renders nothing at all.
 */
function obsoleteNeighbourLines(neighbours: ObsoleteNeighbour[]): string[] {
  if (neighbours.length === 0) return [];
  const lines = neighbours.map((n) => {
    const by = n.supersededByKeys.length > 0 ? n.supersededByKeys.join(', ') : 'nothing recorded';
    const note = n.noteFirstLine ? ` ${n.noteFirstLine}` : '';
    return `- \u26a0 ${n.role} ${n.key} is ${n.mark.toUpperCase()} \u2014 superseded by ${by}.${note}`;
  });
  lines.push(
    "  An OUTDATED item's body is history: read what it does now from the items that" +
      ' superseded it. A DEPRECATED one was retired on purpose: do not build on it.',
  );
  return lines;
}

/** How the prompt names the surface a refusal arrived through. */
const REFUSAL_SOURCE_LABEL: Record<NonNullable<LatestRefusalDTO['decisionSource']>, string> = {
  ui: 'in Motir',
  api: 'through the Motir API',
  mcp: 'through Motir MCP',
  github: 'in a GitHub review',
  // Total over the enum. A system decision is only ever an APPROVAL (MOTIR-697), so
  // no refusal reaches a prompt with this source.
  system: 'automatically, by a project setting',
};

/** What each design verdict tells the next run (MOTIR-6421; `design-refusal-verdict.md`). */
const REFUSAL_VERDICT_LINE: Record<NonNullable<LatestRefusalDTO['refusalVerdict']>, string> = {
  revise: 'Revise — the reviewer asked for this work to be revised.',
  re_plan: 'Re-plan — the reviewer judged the plan around this work wrong.',
};

/**
 * CONTINUE (Story MOTIR-6526 · MOTIR-6531; `run-death-keeps-work.md` §4) — the
 * agent is not starting this work item, it is CARRYING ON a run that died. It is
 * told whose run, how it ended, where the work is, and the rules of inheriting
 * it: read what is there first, keep what is right, and do not start again.
 *
 * NULL renders nothing: almost every run is a fresh one.
 */
function continueSection(cf: ContinueFromForPrompt | null): string[] {
  if (cf === null) return [];
  if (cf.resume) return resumeSection(cf, cf.resume);
  return [
    '',
    'CONTINUE — you are carrying on a run that DIED, not starting fresh',
    '',
    `  The previous run (${cf.deadRunId}) was run by ${cf.dispatcherName ?? 'somebody no longer resolvable'}.`,
    `  It ended: ${cf.endedHow}. Last heard from ${cf.lastHeardAt}.`,
    ...continueWhereLines(cf),
    '',
    "  You are CONTINUING someone else's work:",
    '    - read `git log origin/main..HEAD` and `git status` FIRST, before changing',
    '      anything, and understand what is already done;',
    '    - keep what is right; do not start over and do not redo finished work;',
    ...(continueRepoSet(cf)
      ? [
          '    - do NOT create a new branch in any repository — the GIT WORKFLOW below',
          '      checks each one out;',
          '    - do NOT open a second pull request in any repository — reuse the one',
          '      that is open there, if any.',
        ]
      : [
          '    - do NOT create a new branch — the GIT WORKFLOW below checks this one out;',
          '    - do NOT open a second pull request — reuse the one that is open, if any.',
        ]),
  ];
}

/**
 * RESUME AFTER AN APPROVAL (Story MOTIR-7701 · MOTIR-7708) — the CONTINUE lane for a
 * run that stopped cleanly at a gate. Nothing died: the previous run did everything
 * it could and stopped because the rest waited on a person. Some of that is now
 * approved, so the agent re-reads the verdicts, builds what they released, and stops
 * at a gate again on anything still waiting.
 */
function resumeSection(
  cf: ContinueFromForPrompt,
  resume: NonNullable<ContinueFromForPrompt['resume']>,
): string[] {
  const gate = (g: { key: string; kind: string }) => `${g.key} (${g.kind})`;
  return [
    '',
    'RESUME — you are resuming a run that STOPPED AT A GATE, after an approval',
    '',
    `  The previous run (${cf.deadRunId}) was run by ${cf.dispatcherName ?? 'somebody no longer resolvable'}.`,
    '  It stopped because the rest of its work waited on these approval gates, and',
    `  these are now approved: ${resume.approved.length > 0 ? resume.approved.map(gate).join(', ') : 'none were recorded'}.`,
    ...(resume.changesRequested && resume.changesRequested.length > 0
      ? [
          `  Changes were requested on: ${resume.changesRequested.map(gate).join(', ')}.`,
          "  Read each one's reason (the CHANGES REQUESTED section, or get_approval_gate)",
          '  and redo that work; it is decided, not waiting.',
        ]
      : []),
    ...(resume.stillWaiting.length > 0
      ? [
          `  Still waiting: ${resume.stillWaiting.map((g) => `${gate(g)} — ${g.state}`).join(', ')}.`,
        ]
      : []),
    ...continueWhereLines(cf),
    '',
    '  You are RESUMING this run, not starting fresh:',
    "    - re-read each approved gate's verdict (get_approval_gate, get_design) before",
    '      building on it — build what the approval released, as it was approved;',
    '    - read `git log origin/main..HEAD` and `git status` FIRST, and keep what is',
    '      already done; do not redo finished work;',
    ...(continueRepoSet(cf)
      ? [
          '    - do NOT create a new branch in any repository — the GIT WORKFLOW below',
          '      checks each one out;',
          '    - do NOT open a second pull request in any repository — reuse the one',
          '      that is open there, if any;',
        ]
      : [
          '    - do NOT create a new branch — the GIT WORKFLOW below checks this one out;',
          '    - do NOT open a second pull request — reuse the one that is open, if any;',
        ]),
    '    - work that still waits on a gate is NOT yours to build: when only such work',
    '      is left, stop again and close the run `gated`.',
  ];
}

/** Where the dead run's work is — one branch, or one per repository. */
function continueWhereLines(cf: ContinueFromForPrompt): string[] {
  const repos = continueRepoSet(cf);
  if (repos) {
    return [
      `  Its work spans ${repos.length} repositories, on a branch in each:`,
      ...repos.flatMap((b) => [
        `    - ${b.repository ?? '<repo>'}: ${b.branch}` +
          (b.pullRequest ? ` — open pull request #${b.pullRequest.number}` : ''),
        ...(b.pullRequest ? [`      (${b.pullRequest.url})`] : []),
      ]),
    ];
  }
  return [
    `  Its work is on the branch ${cf.branch}.`,
    ...(cf.pullRequest
      ? [
          `  It left an open pull request: ${cf.pullRequest.repo} #${cf.pullRequest.number}`,
          `  (${cf.pullRequest.url}).`,
        ]
      : []),
  ];
}

/**
 * CHANGES REQUESTED (Story MOTIR-6070 · Subtask MOTIR-6422; ADR `approval-gates.md`
 * §10h note 4) — the reason the last attempt was sent back, handed to the next one.
 *
 * Keyed on "the latest DECISION on the card was a refusal", never on a gate kind: a
 * design sent back and a story's acceptance sent back (MOTIR-6071) render the same
 * block. An approval after the refusal removes it — the service answers null — so
 * it is never shown for a question that has since been answered yes.
 *
 * ⚠️ THE REASON IS QUOTED VERBATIM. A GitHub review submitted with no body has no
 * reason, and says so in §10b's words — never a blank, and never the Motir wording,
 * because nobody in Motir was asked.
 *
 * EMPTY renders nothing: almost every card was never sent back.
 */
function changesRequestedSection(refusals: readonly ChangesRequestedForPrompt[]): string[] {
  if (refusals.length === 0) return [];
  const lines: string[] = ['', 'CHANGES REQUESTED — the last attempt was sent back, and why'];
  for (const refusal of refusals) {
    const who = refusal.decidedByLabel ?? 'somebody no longer resolvable';
    const where = refusal.decisionSource ? ` ${REFUSAL_SOURCE_LABEL[refusal.decisionSource]}` : '';
    lines.push(
      '',
      `  ${refusal.key} — its ${refusal.kind} gate was refused`,
      `    by ${who}${where}, on ${refusal.decidedAt}`,
      `    refused version: ${refusal.subjectVersion ?? 'not recorded'}`,
    );
    if (refusal.refusalVerdict) {
      lines.push(`    verdict: ${REFUSAL_VERDICT_LINE[refusal.refusalVerdict]}`);
    }
    lines.push('    reason (verbatim):');
    if (refusal.noteMd !== null && refusal.noteMd.trim().length > 0) {
      lines.push(...indent(refusal.noteMd, '      '));
    } else {
      lines.push(
        refusal.decisionSource === 'github'
          ? '      (no reason given on GitHub)'
          : '      (no reason was recorded)',
      );
    }
  }
  lines.push(
    '',
    '  ADDRESS THIS REASON IN THIS ATTEMPT. Do not hand back the refused version',
    '  unchanged: change what the reason names, and say in your outcome report how',
    '  you answered it.',
  );
  return lines;
}

/**
 * THE EPIC'S CONFIRMED DECISIONS, and the CALENDAR RULE that says how to read them
 * (Story MOTIR-5871 · Subtask MOTIR-5959; ADR `approval-gates.md` §1's MOTIR-5952
 * amendment, point 10).
 *
 * ⚠️ A confirmed decision is auditable INTENT, not enforcement. The instruction
 * exists because the other reading — treat the decision as law — would have an
 * agent "fix" code a person changed later on purpose, turning a record into a
 * regression. So the section tells the agent to DATE the contradiction before it
 * acts, and to REPORT a newer contradicting code path rather than change it.
 *
 * EMPTY renders nothing: most epics carry no decision.
 */
function confirmedDecisionsSection(decisions: readonly ConfirmedDecisionForPrompt[]): string[] {
  if (decisions.length === 0) return [];
  const lines: string[] = [
    '',
    'CONFIRMED DECISIONS ON THIS EPIC — the direction a person agreed, oldest first',
  ];
  for (const decision of decisions) {
    if (decision.page) {
      // An agent decision approved over a PAGE (MOTIR-7438): the approved text is
      // the FROZEN version, read by number — never the live page, which may since
      // have moved on.
      const projectKey = decision.key.replace(/-\d+$/, '');
      lines.push(
        '',
        `  ${decision.key} — ${decision.title}`,
        `    approved ${decision.decidedAt}`,
        '    Read the approved text — that version, not the page as it is now:',
        `      get_page { projectKey: "${projectKey}", pageId: "${decision.page.pageId}", version: ${decision.page.versionNumber} }`,
      );
      continue;
    }
    lines.push(
      '',
      `  ${decision.key} — ${decision.title}`,
      `    confirmed ${decision.decidedAt}`,
      '    Decision:',
      ...indent(decision.decisionMd, '      '),
      '    Resulting direction:',
      ...indent(decision.resultingDirectionMd, '      '),
    );
  }
  lines.push(
    '',
    'HOW TO READ THEM — the calendar rule:',
    '  - A confirmed decision is the direction agreed for work NOT YET DONE. Where a',
    '    decision is NEWER than the code it describes, the decision governs your work.',
    '  - Where the code you are reading CONTRADICTS a decision, date that code first:',
    '    `git log -1 --format=%cI -- <path>`. If it was committed AFTER the decision was',
    '    confirmed, the code is what IS — a person changed it later. DO NOT change it to',
    '    match the decision. REPORT the contradiction instead: the decision key, the path',
    '    and the commit date, in your pull request body AND in a comment on this card —',
    '    then carry on with the card’s own scope.',
    '  - The latest decision restates the whole direction; an earlier one explains why',
    '    something shipped. Read them in order, and never undo shipped work on the',
    '    strength of an older decision alone.',
  );
  return lines;
}

function indent(markdown: string, prefix: string): string[] {
  const body = markdown.trim();
  return (body.length > 0 ? body : '(empty)').split('\n').map((line) => `${prefix}${line}`);
}

/** The ACCEPTANCE CRITERIA section — the card's own criteria, or the honest
 *  fallback when it names none. */
function acceptanceSection(criteria: string[]): string[] {
  if (criteria.length > 0) return criteria;
  return [
    'The card names no explicit acceptance criteria. Satisfy everything the',
    'description asks for — and nothing beyond it.',
  ];
}

/**
 * The repository SET, but ONLY when it is one this grammar has anything extra to
 * say about. Fewer than two repositories is today's world, and this returns
 * `null` for it so every caller reads one condition rather than three.
 */
function multiRepoSet(
  src: DispatchPromptSource,
): { name: string; defaultBranch: string | null }[] | null {
  const repos = src.targetRepos ?? [];
  return repos.length >= 2 ? repos : null;
}

/** The branch a card takes — the SAME name in every repository it ships in. */
function cardBranch(src: DispatchPromptSource): string {
  return `${branchPrefix(src.type)}/${src.key}-${branchSlug(src.title)}`;
}

/** How to reach a repository from the agent's working directory (the primary's
 *  checkout): itself, or a sibling under the workspace root. */
function siblingDir(repo: string, index: number): string {
  return index === 0 ? '.' : `../${repo}`;
}

/**
 * The per-repository steps of a MULTI-repository `per_item_pr` workflow — one
 * block per repository, in set order, primary first.
 *
 * Every block is complete on its own: enter the repository, branch, work,
 * commit, push, open a pull request — and then LINK it.
 *
 * ⚠️ CORRECTED (Story MOTIR-3525 · MOTIR-3529). This docstring used to end
 * *"open a pull request whose TITLE carries the key. The key in the title is the
 * load-bearing part and the one an agent would most plausibly drop — the
 * completion gate counts merges against the item's LINKED pull requests, so a
 * pull request without it is invisible to the gate and the card is held forever
 * by work that has actually shipped."*
 *
 * That account of the STAKES was right and is kept: the completion gate does
 * count merges against the item's LINKED pull requests, a pull request the gate
 * cannot see does hold a card open on work that shipped, and it is exactly the
 * thing an agent would most plausibly drop. What was wrong was the MECHANISM. A
 * title is a string somebody typed, and hoping `resolveChangeRequestWorkItem`
 * parses it back out fails in both directions — a dropped key is invisible, and
 * a merely MENTIONED key closes a card the pull request never delivered.
 *
 * `link_pull_request` (MOTIR-3526) is the mechanism now: the agent DECLARES the
 * link at the one moment it knows the answer with certainty. The key stays in
 * the branch and the title as a LABEL, for a human reading a list. Do not
 * restore the title rule from the paragraph above — its reasoning is preserved
 * here precisely so the next reader does not re-derive it.
 *
 * ⚠️ AND `resolveChangeRequestWorkItem` NO LONGER EXISTS (MOTIR-3674): the parse
 * is retired at both its call sites, so the title is not even a fallback now.
 * An unlinked pull request associates with nothing at all.
 *
 * ⚠️ EXTENDED, NOT REPLACED (MOTIR-3678), and the instruction above holds with
 * MORE force than when it was written. The paragraph the older rule is quoted in
 * exists so that a reader who meets `link_pull_request` and thinks *"surely the
 * title still works as a backstop"* finds the answer here instead of re-deriving
 * it. Retiring the parse makes that re-derivation newly tempting — a mechanism
 * that is gone leaves no error message behind, so the only trace of it is this
 * paragraph. **Do not restore the title rule, and do not delete the record of
 * it.** What replaces the fallback is not silence but a RED CHECK: an unlinked
 * pull request fails `Motir / work item link` (MOTIR-3675), which is where a
 * person now learns what the title used to do for them.
 */
function multiRepoPrBlocks(
  src: DispatchPromptSource,
  repos: NonNullable<ReturnType<typeof multiRepoSet>>,
) {
  const branch = cardBranch(src);
  const lines: string[] = [];
  repos.forEach((repo, i) => {
    // Every step is relative to the repository's OWN checkout, which step 1
    // enters — so the worktree path is the same `../<repo>-<key>` the
    // single-repository grammar renders, for every element of the set.
    const wt = worktreeDir(repo.name, src.key);
    lines.push(
      '',
      `${repo.name}${i === 0 ? '  (your working directory)' : '  (a sibling checkout)'}`,
      '',
      `  1. cd ${siblingDir(repo.name, i)} && git fetch origin`,
      `  2. git worktree add ${wt} -b ${branch} origin/${repo.defaultBranch ?? 'main'}`,
      `  3. cd ${wt}, install dependencies, and do THIS repository's half of the work here.`,
      '  4. Stage with explicit `git add <path>` — never `-A`.',
      `  5. Commit with a Conventional Commits subject that carries ${src.key}.`,
      ...checkpointLines(branch, '  '),
      `  6. Push the branch and open a pull request against ${repo.defaultBranch ?? 'main'}.`,
      `     Put ${src.key} in the TITLE as well, as a label for a human reading a`,
      '     list — it is not what links the pull request.',
      ...linkingStep(src, branch, 7, {
        indent: '  ',
        baseRef: repo.defaultBranch ?? 'main',
        trailer: [
          'ONCE PER REPOSITORY — each repository has its own pull request, so each',
          'needs its own call; the item completes only when they have all merged.',
        ],
      }),
    );
  });
  return lines;
}

/**
 * The MULTI-repository `per_item_pr` GIT WORKFLOW: one worktree, one branch and
 * one pull request PER REPOSITORY, and the item completes only when every one of
 * them has merged.
 *
 * ONE branch NAME across all of them, deliberately. It is what makes the set
 * legible as halves of one change rather than two unrelated pushes that happen
 * to share a key — `gh pr list --head <branch>` finds them all — and one level
 * up it is what lets the item record a single `sessionBranch`, which is a scalar.
 */
function multiRepoPerItemPrWorkflow(
  src: DispatchPromptSource,
  repos: NonNullable<ReturnType<typeof multiRepoSet>>,
): string[] {
  return [
    `This item ships in ${repos.length} repositories, so it needs ONE pull request in`,
    'EACH of them. It has no session lineage, so they are pull requests of its own.',
    '',
    `The branch name is the SAME in every repository: ${cardBranch(src)}`,
    ...multiRepoPrBlocks(src, repos),
    '',
    `STOP at the ${repos.length} open pull requests. Do not merge any of them and do not`,
    'delete any branch. This item is not complete until EVERY one of them has merged —',
    'a single merged pull request leaves it held, waiting on the others.',
    '',
    // MOTIR-9235 — this used to say only "say so in the outcome report", and
    // nothing turned that report into a decision: the repository stayed on the
    // card, the completion gate counted it `awaiting`, and the card was held at
    // its last status for ever after the real work merged. The agent is the one
    // reader who KNOWS the repository needs nothing, so it settles the card.
    'If one repository turns out to need no change at all, open no pull request there.',
    `Take it off the card instead: call the update_work_item tool with key ${src.key}`,
    'and targetRepos set to the repositories you DID change, in their current order.',
    'The item completes only when every repository on its list has merged, so a',
    'repository left there holds it open for ever. Then record why as a point of your',
    'ONE record_run_discrepancy call — planAsked: that repository; built: no change;',
    'why: what made the change unnecessary — and name it in your outcome report.',
  ];
}

/**
 * The MULTI-repository `session_lineage` GIT WORKFLOW: the SAME session branch
 * in every repository, integrated in each, and exactly ONE `mark_integrated`.
 *
 * One call, not one per repository: `mark_integrated` reports THE ITEM's
 * lineage, and the item has one — `work_item.sessionBranch` is a scalar, which
 * is the same reason the branch name is shared.
 */
function multiRepoSessionLineageWorkflow(
  src: DispatchPromptSource,
  repos: NonNullable<ReturnType<typeof multiRepoSet>>,
  sessionBranch: string,
): string[] {
  const branch = cardBranch(src);
  const lines: string[] = [
    `This item inherits the session branch ${sessionBranch}, and it ships in`,
    `${repos.length} repositories. The lineage is the SAME branch name in each of them:`,
    'the work it depends on is integrated there and awaiting ONE human review, so this',
    'work joins that lineage in every repository instead of opening pull requests.',
    '',
    `Your working branch is the same in each too: ${branch}`,
  ];
  repos.forEach((repo, i) => {
    const wt = worktreeDir(repo.name, src.key);
    lines.push(
      '',
      `${repo.name}${i === 0 ? '  (your working directory)' : '  (a sibling checkout)'}`,
      '',
      `  1. cd ${siblingDir(repo.name, i)} && git fetch origin`,
      `  2. git worktree add ${wt} -b ${branch} origin/${sessionBranch}`,
      `  3. cd ${wt}, install dependencies, and do THIS repository's half of the work here.`,
      '  4. Stage with explicit `git add <path>` — never `-A`.',
      `  5. Commit with a Conventional Commits subject that carries ${src.key}.`,
      ...checkpointLines(branch, '  '),
      `  6. Integrate the commit into ${sessionBranch} and push that branch.`,
    );
  });
  lines.push(
    '',
    `Then report it ONCE: call the mark_integrated tool with key ${src.key} and`,
    `sessionBranch ${sessionBranch}. One call for the item, not one per repository —`,
    'the item records a single session branch, which is why the name is shared.',
    '',
    'Do NOT open a pull request OF YOUR OWN in any repository. The session branch has',
    'one review surface per repository, and the run opens it at the first item that',
    'reaches Implemented there — so it usually already exists by the time you get',
    `here (\`gh pr list --head ${sessionBranch}\`). If a repository you touched has`,
    'none yet, you are the first: open it from that branch, targeting its default',
    'branch.',
    '',
    'Then, in EACH repository whose session pull request you found or opened:',
    ...linkingStep(src, sessionBranch, 1, {
      trailer: [
        'ONCE PER REPOSITORY, and once per item — several items link the same session',
        'pull request, which is exactly what the delivery table records.',
      ],
    }),
  );
  return lines;
}

/**
 * THE LINKING SENTENCE — one text, every grammar (Story MOTIR-3672 · MOTIR-3678).
 *
 * `docs/decisions/work-item-delivery-links.md` settled that `link_pull_request`
 * stays SINGLE-KEY and is called ONCE PER ITERATION in every lane, and it wrote
 * the agent instruction out in full precisely so there would be nothing to infer:
 *
 *   > **When your work is committed and the pull request exists, call
 *   > `link_pull_request` with your card and that pull request.**
 *
 * ⚠️ NO GRAMMAR BRANCH, and that is the point rather than an economy. A per-lane
 * variant asks the agent to work out which lane it is in before it can follow an
 * instruction, and an agent that has to infer its lane infers other things too.
 * `motir auto` opens its pull request at the first implemented card and reuses
 * it, so there is no lane in which the association is deferred or guessed — which
 * is what makes one sentence sufficient.
 *
 * {@link LINKING_RATIONALE} is the part that carries the MEANING and it is a
 * constant with no interpolation, so it renders byte-identically wherever it
 * appears; only the step number, the branch and the base ref differ. A test
 * asserts every grammar contains it verbatim, so an edit to one cannot drift
 * from the others (MOTIR-3678 AC 5).
 */
export const LINKING_RATIONALE = [
  'The link is the ONLY thing that associates a pull request with a card.',
  'There is no fallback: the key in the branch and in the title is a LABEL for a',
  'human reading a list, and Motir does not parse it. An unlinked pull request',
  'moves no card when it merges, AND fails a check named "Motir / work item link"',
  'whose text repeats this call. If you see that check red, this step is what',
  'clears it — it goes green on the link itself, so you do not need to push again.',
];

/** The linking STEP, in the shape the surrounding list needs: `indent` for the
 *  per-repository blocks, which are nested one level. */
export function linkingStep(
  src: DispatchPromptSource,
  branch: string,
  stepNumber: number,
  opts: { indent?: string; baseRef?: string; trailer?: string[] } = {},
): string[] {
  const pad = opts.indent ?? '';
  const body = pad + '   ';
  return [
    `${pad}${stepNumber}. LINK it: call the link_pull_request tool with key ${src.key} and the`,
    `${body}pull request (its URL, or repository + number), plus headRef ${branch}`,
    `${body}and baseRef ${opts.baseRef ?? 'main'}. Do this in the SAME iteration that did`,
    `${body}the work, while the pull request is in front of you — not at the end of`,
    `${body}the run.`,
    ...(opts.trailer ?? []).map((l) => `${body}${l}`),
    '',
    ...LINKING_RATIONALE.map((l) => `${body}${l}`),
  ];
}

/**
 * THE CHECKPOINT (MOTIR-6531) — every run pushes its branch after each commit, so
 * a run that dies leaves its commits on origin for `motir continue`. Rendered as a
 * continuation of the COMMIT step rather than a numbered step of its own, so no
 * later step renumbers. It opens no pull request, so no CI promotion or card link
 * fires mid-run.
 */
function checkpointLines(branch: string, pad = ''): string[] {
  return [
    `${pad}   CHECKPOINT: push the branch after EVERY commit — \`git push -u origin ${branch}\`.`,
    `${pad}   It keeps your work safe if this run dies; it opens no pull request.`,
  ];
}

/** The per-item-PR GIT WORKFLOW: branch from `origin/main`, one PR, stop. */
function perItemPrWorkflow(src: DispatchPromptSource): string[] {
  const branch = `${branchPrefix(src.type)}/${src.key}-${branchSlug(src.title)}`;
  const dir = worktreeDir(src.targetRepo, src.key);
  return [
    'This item has no session lineage, so it ships as ONE pull request of its own.',
    '',
    `1. git fetch origin && git worktree add ${dir} -b ${branch} origin/main`,
    `2. cd ${dir}, install dependencies, and do ALL the work inside this worktree.`,
    '3. Stage with explicit `git add <path>` — never `-A`, so concurrent work in',
    '   other worktrees, or unrelated local edits, cannot ride along in your commit.',
    `4. Commit with a Conventional Commits subject that carries ${src.key}.`,
    ...checkpointLines(branch),
    '5. Push the branch and open a pull request against main. Put',
    `   ${src.key} in the TITLE as well — a human scanning a pull-request list`,
    '   reads it there — but the title is a LABEL, not what links the pull',
    '   request. Step 6 is what links it.',
    ...linkingStep(src, branch, 6),
    '7. STOP at the open pull request. Do not merge it and do not delete the branch.',
  ];
}

/** The session-lineage GIT WORKFLOW: branch from / integrate into the inherited
 *  session branch, then report it with `mark_integrated`. */
function sessionLineageWorkflow(src: DispatchPromptSource, sessionBranch: string): string[] {
  const branch = `${branchPrefix(src.type)}/${src.key}-${branchSlug(src.title)}`;
  const dir = worktreeDir(src.targetRepo, src.key);
  return [
    `This item inherits the session branch ${sessionBranch}: the work it depends on`,
    'is integrated there and awaiting ONE human review, so this work joins the SAME',
    'lineage instead of opening a pull request of its own.',
    '',
    `1. git fetch origin && git worktree add ${dir} -b ${branch} origin/${sessionBranch}`,
    `2. cd ${dir}, install dependencies, and do ALL the work inside this worktree.`,
    '3. Stage with explicit `git add <path>` — never `-A`.',
    `4. Commit with a Conventional Commits subject that carries ${src.key}.`,
    ...checkpointLines(branch),
    `5. Integrate the commit into ${sessionBranch} and push that branch.`,
    `6. Report it: call the mark_integrated tool with key ${src.key} and`,
    `   sessionBranch ${sessionBranch}.`,
    '7. Do NOT open a pull request of your own. The session branch has ONE review',
    `   surface: a pull request from ${sessionBranch}, which the run opens at the`,
    '   first item that reaches Implemented in this repository. So by the time you',
    '   are reading this it USUALLY ALREADY EXISTS — find it with',
    `   \`gh pr list --head ${sessionBranch}\`. If it does not exist yet, you are the`,
    '   first: open it, from that branch, targeting main.',
    ...linkingStep(src, sessionBranch, 8),
    '9. STOP. Do not merge that pull request and do not delete the branch.',
  ];
}

/**
 * WHICH MODEL RAN (MOTIR-2419) — the one fact only the agent holds.
 *
 * Every other half of the implementation provenance triple is derivable by the
 * launcher: it knows the source (a BYOK machine) and it knows the harness (it
 * ran the command). The MODEL is visible nowhere outside the agent process, so
 * either the agent says it or the record is empty forever — a run cannot be
 * re-interrogated after it exits.
 *
 * Applies to BOTH outcomes, which is why it sits above them: a card that turned
 * out to be wrong was still worked by a model, and knowing which one is part of
 * knowing what the finding is worth.
 *
 * The instruction is conditional on the environment variable rather than on a
 * prompt variant, because this prompt is also what a human reads when they run
 * `motir next --print` — there is no report file in that case, and an
 * unconditional instruction would have them inventing a path.
 *
 * The channel is a file rather than a tool call on purpose. Reporting the model
 * over MCP would put a claim about the run on the ITEM, where nothing could
 * check it against the process that made it; the file is written by the agent
 * into a directory the launcher created for this one dispatch and deletes when
 * it ends, so a report can only ever describe the run it came from.
 */
/**
 * REPORTING YOUR STEPS (Story MOTIR-7446 · MOTIR-7501,
 * `docs/decisions/agent-reported-runs.md` §3) — the agent's own step-by-step
 * account of the run, through `report_action`.
 *
 * The runner around the agent — `motir run`, a hosted run — already reports the
 * milestones (the checkout, the pull request, the verdict) and keeps the run
 * alive; what it cannot see is what the agent does BETWEEN them. `report_action`
 * finds the caller's open run from the card's key, so the same call a skill-driven
 * agent makes lands in the CLI's run too, and every run carries the same steps
 * whoever started it.
 *
 * Milestones are refused here (`events` in a runner's run), so the block says not
 * to send them; it says what an action may never contain, because the line is
 * stored and shown on the run.
 */
function stepReporting(key: string): string[] {
  return [
    `Before EACH step you take, call the report_action tool with key ${key} and`,
    'the step you are about to take, in one line — for example:',
    '',
    `         report_action { key: "${key}", action: "Run the changed tests" }`,
    '',
    '  - One line, at most 500 characters, said BEFORE the step, not after it.',
    '  - Never a transcript, file contents, a diff, a prompt or a secret: the line',
    '    is stored on the run and shown to the people who watch it.',
    '  - Do not send `events`. The runner around you reports the milestones itself,',
    '    and report_action refuses them in its run.',
    '  - If report_action answers `no_open_run`, carry on with the work: there is no',
    '    run to report into, and nothing else depends on the call.',
  ];
}

function modelSelfReport(): string[] {
  return [
    'FIRST, one line of bookkeeping that applies to BOTH outcomes below. If the',
    'environment variable MOTIR_AGENT_REPORT is set, write a JSON file at that path:',
    '',
    '         {"model": "<the model you are running as>"}',
    '',
    '  Name the model as precisely as you can — the identifier, not the family.',
    '  Nothing outside your process can observe which model answered, so this is the',
    "  only chance to record it, and it becomes the work item's implementation",
    '  provenance.',
    '',
    '  If you genuinely cannot tell, leave "model" out — write no file at all unless',
    '  a step below asks you to add to it: an empty record is honest,',
    '  and a guessed one is not. If the variable is unset, skip this entirely.',
  ];
}

/**
 * REPORTING THE OUTCOME (MOTIR-2406) — the two signals the loop cannot infer.
 *
 * ⚠️ WHY THIS IS IN THE PROMPT AND CANNOT BE ANYWHERE ELSE. `motir auto` runs
 * `claude --dangerously-skip-permissions` in a sandbox against the user's own
 * key. There is no wrapper, no policy layer and no second channel: the prompt is
 * the ENTIRE contract with the agent, and whatever is not in it does not happen.
 * An instruction that lives in a runbook, a CLAUDE.md or a reviewer's
 * expectations is an instruction the sandboxed agent never receives.
 *
 * Unconditional — no mode, no parameter. A human-driven `motir run` should
 * report the same way, and a signal that only some dispatches carry is a signal
 * the loop cannot rely on.
 *
 * The FAILURE THIS PREVENTS IS THE QUIET ONE. An agent that cannot do what the
 * card says will still do something — that is what makes it useful the rest of
 * the time. Faced with a false premise it finds the nearest satisfiable
 * interpretation and ships that, with a green test run and a confident pull
 * request, and the defect surfaces later as a change nobody asked for sitting on
 * a card nobody re-read. Telling it to stop and describe what it found turns the
 * most expensive failure mode into the cheapest one.
 */
/**
 * WHAT ENDS THIS WORK, and what does not.
 *
 * Three branches (MOTIR-3020, `docs/decisions/run-findings-protocol.md`), and the
 * third one is the one an agent gets wrong without being told: FINISHED and THE
 * CARD IS WRONG are both about the card in hand, while FOUND A DEFECT is about
 * something else entirely and must NOT end the run.
 *
 * Two of the three are switchable by the run's {@link FindingsPolicy}, and a
 * disabled branch renders NOTHING — no heading, no blank line, no trace — the
 * same empty-in-nothing-out shape {@link advisorySection} uses. What replaces it
 * is not silence: the agent is told what to do INSTEAD, because an agent with a
 * finding and no instruction improvises.
 */
/**
 * THE OUTCOME PROTOCOL OF AN AGENT'S DECISION CARD (Story MOTIR-5761 · MOTIR-7437).
 * The same two outcomes as {@link outcomeProtocol}, with the FINISHED order a page
 * takes: the publish is the hand-over, and it moves the card to review itself, so
 * the agent writes no status. There is nothing to commit, push, link or test.
 */
function decisionOutcomeProtocol(src: DispatchPromptSource): string[] {
  const policy = src.findingsPolicy ?? FULL_FINDINGS_POLICY;
  return [
    'Two outcomes end this work, and the loop can only tell them apart if you SAY',
    'which one happened. A process that exits 0 proves the process ended, nothing',
    'more.',
    '',
    ...modelSelfReport(),
    '',
    'FINISHED — the decision page is written and published:',
    '',
    '    1. the page is complete (WHAT TO DO step 3)',
    `    2. publish_decision_page has returned for ${src.key}, with a gateId: that`,
    '       is the question now waiting on a person',
    '    3. say in your report which page and version you published, and that the',
    '       decision is AWAITING APPROVAL, not finished',
    '',
    `  Do NOT move ${src.key} with transition_status. The publish moved it to review,`,
    '  and the approval moves it to done; any status you write asserts a decision',
    '  nobody has made. Do NOT publish How to test: a decision has nothing to run.',
    '',
    ...cardIsWrongHeader(),
    ...whatTest(src),
    ...buildThroughSteps(src, { lane: 'decision' }),
    '',
    'STOP — the WHAT itself breaks. In order:',
    '',
    '  1. PUBLISH NOTHING. A page you have started may stay as a draft, but do not',
    '     call publish_decision_page: the publish is what asks a person to approve.',
    ...cardIsWrongSteps(src, policy),
    ...foundADefect(src, policy),
  ];
}

function outcomeProtocol(src: DispatchPromptSource, sessionBranch: string | null): string[] {
  const policy = src.findingsPolicy ?? FULL_FINDINGS_POLICY;
  // ⚠️ THIS BLOCK USED TO CONTRADICT THE SESSION-LINEAGE GRAMMAR, IN ONE PROMPT
  // (found while running MOTIR-3655, fixed here by MOTIR-3678). It renders for
  // BOTH grammars and took only `src`, so it could not vary — and it said
  // *"3. open the pull request"* to an agent whose git workflow three sections
  // earlier said *"do NOT open a pull request for this item"*. An agent handed
  // both has no coherent instruction, and what it does then is not predictable.
  //
  // The fix is the parameter, not a second protocol: the ORDER is the same in
  // both lanes and the order is what this section is for. What differs is one
  // line — whether the pull request is something you open or something the run
  // has already opened — so that line varies and nothing else does.
  const finished = sessionBranch
    ? [
        '    3. find the session pull request for this repository',
        `       (\`gh pr list --head ${sessionBranch}\`), or open it from that branch if`,
        '       you are the first item to reach this point in it',
      ]
    : openPullRequestStep();
  return [
    'Two outcomes end this work, and the loop can only tell them apart if you SAY',
    'which one happened. A process that exits 0 proves the process ended, nothing',
    'more.',
    '',
    ...modelSelfReport(),
    '',
    'FINISHED — the work is done, committed, PUSHED, and its pull request is open:',
    '',
    '  IN THIS ORDER, and the order is the point:',
    '',
    '    1. commit',
    sessionBranch
      ? `    2. integrate into ${sessionBranch} and push that branch`
      : '    2. push the branch',
    ...finished,
    `    4. link it with the link_pull_request tool (key ${src.key}, and that`,
    '       pull request) — once per repository if this item ships in more than',
    '       one. The link is the only association a pull request has; the key in',
    '       the branch and the title is a label Motir does not parse.',
    ...howToTestStep(src),
    `    5. move ${src.key} to Implemented with the transition_status tool`,
    `       (key ${src.key}, status implemented)`,
    '',
    '  Implemented means THE CODE IS ON THE REMOTE — not "I finished typing".',
    '  Transitioning before the push would make the card assert built work that',
    '  exists only in a worktree this run is about to delete. Pushing first makes',
    '  the failure honest instead: if you die after the push, the branch is there',
    '  and the card still reads in progress, which is what an interrupted run is.',
    '',
    '  The transition is REQUIRED, not a courtesy: it is the only positive',
    '  confirmation the run gets, and without it a finished card is',
    '  indistinguishable from an agent that died quietly.',
    '',
    '  Do NOT set In Review. You do not own that status — CI does. It is written',
    '  when the checks on your pushed commit go green, by the webhook, server-side',
    '  and after you have exited. Setting it yourself asserts a green run that has',
    '  not happened yet.',
    '',
    '  In your report, never say a card is finished or a pull request is merged',
    '  when a person still has to act. A project in manual merge mode raises ONE',
    '  approval question over a run’s whole set of pull requests once they are',
    '  green, and a person presses Approve and merge; report them as OPEN AND',
    '  AWAITING APPROVAL. You never approve a gate or merge a pull request.',
    '',
    ...cardIsWrongHeader(),
    ...whatTest(src),
    ...buildThroughSteps(src, { lane: 'code', sessionBranch }),
    '',
    'STOP — the WHAT itself breaks. In order:',
    '',
    '  1. REVERT FIRST. Put the tree back the way you found it and commit',
    '     NOTHING. Do this before anything else — every later step is a step in',
    '     which you might otherwise have committed a half-change.',
    ...cardIsWrongSteps(src, policy),
    ...foundADefect(src, policy),
  ];
}

/**
 * Step 4b of the FINISHED order — publish the RUN's HOW TO TEST onto the RUN
 * TARGET (Story MOTIR-4906 · MOTIR-5334; `docs/decisions/approval-gates.md` §9
 * and its 2026-09-13 amendment: per RUN, on the run target, before the run
 * finishes; the pull-request body keeps its own section).
 *
 * ⚠️ WHO PUBLISHES DEPENDS ON WHAT THE RUN WAS LAUNCHED AGAINST. A card dispatched
 * on its own — or as one card of an unscoped batch — IS its run target, so its
 * agent publishes on its own key. A card dispatched inside a SCOPED run is one
 * child of a target this agent cannot see whole, so it does NOT publish: the run's
 * close-out step does, once, for the target (MOTIR-5357). Asking every child as
 * well would produce fragments on the wrong cards.
 *
 * ⚠️ THE STEP IS UNCONDITIONAL ON A RUN TARGET THAT OPENS A PULL REQUEST; ONLY THE
 * CLICK-PATH IS GATED by {@link RENDERED_SURFACE_TRIGGER}. "Run it locally" and
 * "what CI proved" apply to every change; only a visible change has a click-path.
 *
 * ⚠️ BEFORE `implemented`, AND A REFUSAL DOES NOT BLOCK IT. The reviewer's
 * evidence should exist when the card says it is ready for them; but a card stuck
 * in progress over a missing note is worse than the honest *record missing* state
 * the item page renders, naming this run.
 *
 * ⚠️ "ONCE" IS PER VERSION OF THE STEPS, NOT PER RUN (MOTIR-6065). How to test is
 * written for the WORK ITEM, not for a commit, so a later commit that changes a
 * step it describes owes a re-publish, and one that changes none owes nothing.
 * The item page no longer flags a record whose commit the pull request has moved
 * past — the agent that made the commit is the only party that knows whether the
 * steps moved. The CLI's CI-fix prompt (`renderFixPrompt`) carries the same duty
 * for the commits a fixing agent pushes after this run hands over.
 *
 * Rendered only where the outcome protocol renders — a MANUAL item opens no pull
 * request and gets no protocol at all, so it gets no step.
 */
function howToTestStep(src: DispatchPromptSource): string[] {
  if (src.runTargetKey && src.runTargetKey !== src.key) {
    return [
      `    4b. do NOT publish How to test for ${src.key}. This item is part of a run`,
      `        launched against ${src.runTargetKey}; How to test for that run is written`,
      `        once, onto ${src.runTargetKey}, by the run's close-out step.`,
    ];
  }
  return [
    `    4b. publish this run's HOW TO TEST with the ${HOW_TO_TEST_TOOL_NAME} tool —`,
    `        ONCE, on ${src.key} (this item is the run's target). "bodyMd" is RICH TEXT`,
    '        (Markdown) with sections: the precondition (the sign-in, role, or data',
    '        the surface needs), local setup after checking out the branch (install,',
    '        migrate, seed, run), and the click-path. Put EVERY command in its own',
    '        fenced code block — the reviewer copies it with one click. Motir fills in',
    '        the branch fetch itself — do not include it. Give one "repos" entry per',
    '        repository you pushed to (that repository, commitSha = its pushed head),',
    '        and a previewPath when there is one.',
    `        If this change ${RENDERED_SURFACE_TRIGGER},`,
    '        include the click-path section. Otherwise say in the body why there is',
    '        none, e.g. "no rendered surface changed: a service and its tests".',
    '        If the publish is refused, say so in your FINISHED report and still do',
    '        step 5 — a refused publish does not prevent the transition.',
    `        How to test belongs to ${src.key}, not to a commit. If a later commit`,
    '        in this run changes anything it describes — a precondition, a setup,',
    '        migrate or seed command, a click-path step — publish it again with',
    '        the whole corrected text (the new version supersedes; the old one',
    '        stays as history). A commit that changes none of them needs no new',
    '        publish.',
  ];
}

/**
 * Step 3 in the per-item lane — the pull request this agent OPENS carries a
 * `## How to test` section in its body (Story MOTIR-4906 · MOTIR-5334). The
 * record on the work item is what Motir renders; the body is what a reviewer on
 * the host reads, and §9's amendment keeps both.
 */
function openPullRequestStep(): string[] {
  return [
    '    3. open the pull request. Its body carries a "## How to test" section with',
    '       the SAME Markdown step 4b publishes on the run target — its sections and',
    '       its fenced commands. Write both.',
  ];
}

/**
 * THE CARD IS WRONG, in two ways (Story MOTIR-8651 · MOTIR-8658; the decision page _A run builds
 * through a wrong HOW — the discrepancy record_, MOTIR-8654, which wins wherever this text and it
 * differ).
 *
 * This block used to end *"Do NOT find the nearest thing that works and build that"*, and every
 * wrong card, whether the WHAT or only the HOW was wrong, went down STOP. It now says the card can
 * be wrong in two ways and that the first thing to do is decide which: {@link whatTest} asks the
 * one question, {@link buildThroughSteps} is the YES branch, and {@link cardIsWrongSteps} is the
 * NO branch (STOP) with its text unchanged in substance.
 *
 * Both lanes (code, decision page) and both re-plan policies render the SAME three pieces. The
 * build-through block is NOT switched by {@link FindingsPolicy}: `logBug` and `replan` switch
 * filing and re-planning off, not recording, and `autoApproveReplan` has no bearing on it.
 */
function cardIsWrongHeader(): string[] {
  return [
    'THE CARD IS WRONG — its premise is false, a precondition it names has not',
    'shipped, or an acceptance criterion cannot be satisfied. It can be wrong in two',
    'different ways, and the first thing to do is decide which. Do NOT improvise a',
    'fix that changes what the card asks for.',
    '',
  ];
}

/**
 * The ONE question a run asks when it finds its card wrong. The question is quoted VERBATIM from
 * the decision page (MOTIR-8654), so that every runner text — this prompt, `run.md`, the
 * `motir-run` skill — asks the same thing; the sorting lines are the page's stop-site table, cut
 * to the rows a dispatched agent can meet.
 */
function whatTest(src: DispatchPromptSource): string[] {
  return [
    `Decide which FIRST, before you change anything. The WHAT of ${src.key} is its outcome`,
    'and its acceptance criteria; everything else it says — the route, the helper it',
    'names, the file it says to edit — is the HOW. Ask ONE question:',
    '',
    "  Is the WHAT — the card's outcome and its acceptance criteria — unchanged,",
    "  consistent with itself and with shipped reality and other cards' scope, and",
    '  reachable by this run alone?',
    '',
    '  YES means BUILD THROUGH. For example: a precondition the card names is false',
    '  but you can work around it inside this card; existing code the plan never',
    '  said to change conflicts with it; or a planned HOW cannot be built as written',
    '  while the outcome is reachable another way.',
    '  NO means STOP. The WHAT must change; its criteria contradict each other,',
    "  shipped reality or another card's scope; it needs a person's decision, a",
    "  credential, or another card's unbuilt work; or it cannot ship as one piece.",
    '',
  ];
}

/**
 * BUILD THROUGH — the YES branch (Story MOTIR-8651 · MOTIR-8658).
 *
 * ⚠️ IT CHANGES THE ROUTE, NEVER THE WHAT. What survives from STOP is the half that was
 * load-bearing: no adjacent fix, no widening, nothing outside what the WHAT needs, and no editing,
 * re-scoping, re-parenting or archiving any card. An agent allowed to "build through" without that
 * sentence would use it to widen a card.
 *
 * ⚠️ THE FINISHED ORDER IS POINTED AT, NOT COPIED. `howToTestStep`, `openPullRequestStep` and the
 * session-branch variant stay single-sourced; the discrepancy is recorded BEFORE the lane's
 * delivery step so the pull request can say whether the record is missing.
 *
 * ⚠️ THE RUNNER CLASSIFIES NOTHING. The text names no verdict, no planning bug and no
 * classification: an agent told a bug may be filed writes its points for that audience.
 */
function buildThroughSteps(
  src: DispatchPromptSource,
  where: { lane: 'decision' } | { lane: 'code'; sessionBranch: string | null },
): string[] {
  const decision = where.lane === 'decision';
  const beforeDelivery = decision ? 'publish_decision_page' : 'you commit';
  const finish = decision
    ? [
        '  3. Finish through the FINISHED order above, exactly as written: publish the',
        '     page, and do NOT transition the card.',
      ]
    : [
        '  3. Finish through the FINISHED order above, exactly as written: push, open',
        '     or join the pull request, link it, publish How to test, and move the',
        '     card to Implemented.',
      ];
  const stated = decision
    ? [
        '  4. State the deviations where the page is reviewed: list the same points in',
        '     your FINISHED report.',
      ]
    : where.sessionBranch
      ? [
          '  4. State the deviations where the work is reviewed: add a',
          `     "## Deviations from the plan" section for ${src.key} to the BODY of the`,
          '     session pull request, listing the same points.',
        ]
      : [
          '  4. State the deviations where the work is reviewed: the pull request body',
          '     carries a "## Deviations from the plan" section listing the same points.',
        ];
  return [
    'BUILD THROUGH — the WHAT holds. You are not stopping. In order:',
    '',
    "  1. Do NOT revert. Build to the card's outcome and acceptance criteria, by the",
    '     route that reaches them. What still holds from STOP: no adjacent fix, no',
    '     widening of the WHAT, nothing outside what the WHAT needs. You change the',
    '     ROUTE, never the WHAT. Never edit, re-scope, re-parent or archive any card.',
    `  2. Call the ${RECORD_DISCREPANCY_TOOL_NAME} tool ONCE, after you have built and`,
    `     before ${beforeDelivery}:`,
    '',
    `         key:    ${src.key}`,
    '         points: one entry per deviation, each { planAsked, built, why } —',
    '                 what the plan asked, what you built instead, and why the',
    "                 plan's way could not be followed",
    '',
    '     1–20 points, each field 1–2000 characters. Put EVERY deviation in this one',
    '     call, never one call per point. Do not repeat it: a second call is refused',
    '     DISCREPANCY_ALREADY_RECORDED and writes nothing. It answers',
    `     { commentId, recorded }; recorded: false means ${src.key} has no open run leg.`,
    '     The comment was still written, and that is NOT a failure. A point that',
    '     describes something STILL broken after this card is done is a defect: file',
    '     it as a bug first, by the defect branch that follows this section, and cite',
    "     its key in that point's why.",
    // MOTIR-8810: only a runner that posts `discrepancy` may be named as the route.
    ...(src.runnerPostsAgentReport !== true
      ? []
      : [
          '     NO MOTIR TOOLS? If the record_run_discrepancy tool is not available to you',
          '     (a hosted run, or a run inside an agent, gives you none) and the',
          '     environment variable MOTIR_AGENT_REPORT is set, put the same points into the',
          '     JSON file at that path instead, as "discrepancy" beside "model":',
          '',
          '         {"model": "<as above>", "discrepancy": [{"planAsked": "…", "built": "…", "why": "…"}]}',
          '',
          '     and the run records them on the card and its run when you exit. Then the',
          '     Deviations list says the run records them, and step 5 does not apply.',
        ]),
    ...finish,
    ...stated,
    '  5. If the call errors or is refused, still deliver. Write the exact line',
    '         Discrepancy record missing: <the error code or message>',
    '     both in the Deviations list and in your FINISHED report.',
    '  6. Say BUILD THROUGH in your FINISHED report. Do NOT report the card as',
    '     unbuildable, do NOT move it to Planning, and do NOT send anything to the',
    '     planner: the card is being built, not handed back.',
    '  7. If, while building through, the WHAT turns out to be unreachable after all,',
    '     switch to STOP below, from its step 1. A discrepancy you already recorded',
    '     stays; do not try to undo it.',
  ];
}

/**
 * The steps after the revert, which is where the re-plan switch lives.
 *
 * ⚠️ THE PROHIBITION IS REPLACED, NOT DELETED, and what survives is the half that
 * was load-bearing: DO NOT RESTRUCTURE THE PLAN. An agent that can re-shape the
 * tree can card its way out of a card it cannot finish, which is the exact
 * improvisation this whole protocol exists to prevent.
 *
 * What GOES is the blanket ban on creation and the reason given for it — *"A plan
 * is PROPOSALS awaiting a human's approval; writing the cards would be doing the
 * approving"*. That sentence misdescribes the mechanism: `create_work_item` is a
 * DIRECT write that enters no proposal pipeline and that nobody approves. It is
 * how `motir log-bug` files bugs and how every card of this story was authored.
 *
 * ── THE AGENT COMPOSES THE WHAT (Story MOTIR-3942 · MOTIR-4083) ─────────────
 *
 * The submit used to be ONE shell command — `motir plan --detach <KEY>` — and it
 * sent a key and nothing else. The evidence went into a comment a person reads;
 * the planning job got an identifier, and the first thing a triggered re-plan
 * then did was open a conversation to ask what was wrong — a question whose
 * answer existed and was discarded when the agent exited.
 *
 * Three things about the replacement, each decided rather than incidental:
 *
 *   1. THE DOOR IS THE MCP TOOL. Every other instruction in this branch is a tool
 *      call (`transition_status` four lines up); the one shell-out was the odd
 *      one, and the agent could always have called `submit_plan_session` — it
 *      asserts `ai:plan`, which `CLI_TOKEN_GRANT` carries. Two calls replace one
 *      command line: `append_plan_turn` puts the prose on the thread the web
 *      panel shows, `submit_plan_session` sends it — and carries the WHAT.
 *   2. THE WHAT IS A STRUCT, NOT PROSE. motir-ai's `SettledRequirement` is six
 *      named fields (`REQUIREMENT_FIELDS`, in canonical order) of which three
 *      must be non-empty for the planner to enter at its second phase instead of
 *      opening a conversation. A field a run must fill enforces what an
 *      instruction can only ask for — *"see my comment"* satisfies "pass your
 *      evidence" and supplies nothing, and it cannot satisfy `behaviour`. So the
 *      prompt teaches the FIELDS, by name and by what each is for, in the order
 *      the far side declares them. The names below are asserted against a
 *      fixture mirroring motir-ai's own list (`tests/fixtures/settledRequirement.ts`),
 *      because this seam already failed once with both halves green (MOTIR-4168).
 *   3. THE AGENT GETS ONE SHOT, AND SAYS SO. Nothing goes back and asks it — it
 *      has exited — so the prompt frames the turn as a brief rather than a note.
 *      And "run it once" now has TWO parts: appending starts no job, submitting
 *      is what spends the owner's credits. Both are said, because an agent that
 *      thinks its append submitted stops having done nothing, and one that
 *      retries the submit pays twice for one finding. The single legitimate
 *      retry — a schema-rejected `requirement`, which spent nothing — is its own
 *      sentence, kept apart from "never retry" so the two cannot collapse into
 *      "retry freely".
 *
 * What the prompt does NOT ask for: a diagnosis of the planning rules. That is
 * the fix phase's work, and an agent asked to classify invents. And a refusal
 * never becomes conditional on composing the WHAT well: an agent that cannot
 * articulate the problem is told to submit anyway, without it, and the planner
 * falls back to asking.
 *
 * ── THE REPORT (Story MOTIR-5544 · MOTIR-6287) ──────────────────────────────
 *
 * Step 4, in BOTH lanes, is one `report_unbuildable_target` call carrying the
 * card and the same text as the step-3 comment
 * (`docs/decisions/run-found-trigger-dispatched-path.md`, *The prompt change*).
 * It is in both lanes because the lane changes what the runner does NEXT, not
 * what it found. It is the THIRD part of "run it once": the report (free, safe
 * to repeat — the server keeps one record per run), the append (free), and the
 * submit, which is still the only act that spends credits and is never retried.
 * The runner still classifies nothing: it is told the call spends nothing, is
 * safe to repeat and returns nothing to act on, and NOT what the server does
 * with it — the server classifies, from the approving plan's recorded author and
 * a verdict computed off recorded rows. An agent told a planning defect might be
 * filed would start writing its reason for that audience.
 *
 * One composition, every dispatching path: `run`, `batch`, `auto` and `next` all
 * fetch this same server-assembled prompt, so the instruction is written here
 * and nowhere per command.
 *
 * ⚠️ THE TOOL IS THE FALLBACK, NOT THE ROUTE (MOTIR-8698, the record's AMENDMENT 1).
 * A dispatched agent is handed `$MOTIR_AGENT_REPORT`, so step 4 tells it to write its
 * reason there as `unbuildable`; the CLI reads it after the exit and posts the report
 * with the RUN's credential (`POST /api/v1/dispatch-runs/{id}/unbuildable`). A hosted
 * agent holds no Motir token and `/api/mcp` refuses the run token, and a local agent
 * may have no Motir MCP — the tool reached neither. The tool stays for a reader with
 * no such file (a `--print` prompt pasted into a session that has the MCP).
 *
 * ── NARROWED (2026-10, Story MOTIR-8651 · MOTIR-8658) ───────────────────────
 *
 * These steps are now the STOP branch ONLY: the one a run takes when the WHAT itself breaks,
 * after {@link whatTest} says so. *"Do not improvise"* governs this branch, and
 * {@link buildThroughSteps} is the route-only exception for a card whose HOW alone is wrong
 * (decision page _A run builds through a wrong HOW — the discrepancy record_, MOTIR-8654). The
 * text below is unchanged in substance; the caller renders the `STOP` sub-heading and the
 * lane's own step 1.
 */
function cardIsWrongSteps(src: DispatchPromptSource, policy: FindingsPolicy): string[] {
  const permitted = policy.replan
    ? 'Creating a bug and submitting a re-plan (both below) are permitted.'
    : 'Creating a bug is permitted where this prompt says so.';
  const restructuring = [
    '  2. Do not improvise. No adjacent fix, and no widening the card so it',
    '     becomes satisfiable. Do NOT RESTRUCTURE THE PLAN: no archiving, no',
    '     re-parenting, no re-scoping, and no editing any other card.',
    `     ${permitted}`,
    `  3. Comment the finding on ${src.key}: what is false, and the evidence — the`,
    '     file you read, the command you ran, what it said.',
    ...agentReportStep(src),
  ];

  // The switch. With re-planning disabled there is nothing to submit and nowhere
  // to park the card: it stays In Progress, which is the honest record of a run
  // that started work and stopped, and the operator reads the comment.
  if (!policy.replan) {
    return [
      ...restructuring,
      ...(src.runnerPostsAgentReport === true ? noToolsStop(policy) : []),
      '  5. Stop, and leave the card In Progress. Do not move its status: this run',
      '     was launched without re-planning, so there is no plan to submit and no',
      '     decision for anyone to make yet. Your comment is the whole report:',
      '     describe what is wrong with the CARD, not why it was planned that way.',
      '  6. Do not pick up other work.',
    ];
  }

  return [
    ...restructuring,
    ...(src.runnerPostsAgentReport === true ? noToolsStop(policy) : []),
    `  5. Move ${src.key} to Planning with the transition_status tool (key`,
    `     ${src.key}, status planning). That status is in the in-progress`,
    '     category, which is what actually takes the card out of the pickable set',
    '     — the card is not stuck on a dependency, it is being re-planned, and it',
    '     must not be handed out again until a human has acted on the plan.',
    ...twoLanes(src, policy),
    '  6. Put the finding on the planning thread with the append_plan_turn tool:',
    '',
    `         projectKey: ${src.projectKey}`,
    `         targetKeys: [${src.key}]`,
    '         body:       what you found — the SAME text as your step-3 comment',
    '',
    '     targetKeys anchors the thread to this card. Without it you open the',
    "     PROJECT-WIDE thread and file a plan about one card's defect against the",
    '     whole project. APPENDING IS NOT SUBMITTING: this call costs nothing and',
    '     starts no job. Nothing has reached the planner until step 7.',
    '  7. Compose the WHAT and send it with the submit_plan_session tool:',
    '',
    `         projectKey:  ${src.projectKey}`,
    `         targetKeys:  [${src.key}]   — the same anchor, again`,
    '         requirement: six named fields, in this order —',
    ...requirementBrief(),
    '',
    '     Both calls carry targetKeys, because two calls are two chances to drop',
    '     it. This is your ONLY contribution: nothing will come back and ask you',
    '     — you have exited by the time the planner reads it, and these six fields',
    '     are the whole of what it will ever know from you. Write a brief, not a',
    '     note. Every field is SELF-CONTAINED: "see my comment on the card", "the',
    '     card is wrong" or a bare stack trace supplies nothing, because the',
    '     planner does not open your comment — put the content in the field. The',
    '     three REQUIRED fields must be non-empty; the other three may be "",',
    '     which is an answer, not a blank to skip. Describe what is wrong with the',
    '     CARD, not why it was planned that way: you are not asked to classify the',
    '     mistake, and a guess would be filed as a fact.',
    '     If you genuinely cannot articulate the problem, submit anyway, WITHOUT',
    '     requirement — refusing the card must never wait on writing well. The',
    '     planner opens a conversation with the operator instead.',
    "  8. SUBMITTING IS THE ACT THAT SPENDS the token owner's AI credits, and you",
    '     do it exactly ONCE. Never retry it, even on a timeout — a blind retry in',
    '     an unattended run costs them twice for one finding. The one exception:',
    '     if submit_plan_session REJECTS your arguments (a malformed requirement),',
    '     nothing happened — no job was created and no credits were spent — so',
    '     re-submit once, WITHOUT the requirement. That is the only retry there is.',
    '  9. Stop. Do not pick up other work.',
  ];
}

/**
 * STOP step 4 — the report, routed by WHO WILL POST IT (MOTIR-8810).
 *
 * MOTIR-8698 made `$MOTIR_AGENT_REPORT` the route: the agent writes its reason there as
 * `unbuildable` and the CLI posts it with the run's credential. That holds only for a CLI
 * that does the posting. The published `@motir/cli` 0.12.0 predates it and reads `model`
 * alone, so the deployed prompt sent every report it handled into a file nothing read.
 *
 * So the file route renders only when the runner said it posts (`runnerPostsAgentReport`,
 * which the `/api/v1` route sets from the client's declaration); otherwise step 4 is the
 * tool call it was before MOTIR-8698, word for word.
 *
 * ⚠️ THIS IS THE GUARD THE NEXT PROMPT CHANGE NEEDS TOO. A prompt that routes work through
 * the runner is a contract with a CLI release, and the server is deployed before anyone
 * installs that release. A new route the runner owns renders behind the client's own
 * declaration, never on the assumption that the CLI on `main` is the CLI people run.
 */
function agentReportStep(src: DispatchPromptSource): string[] {
  const call = [
    '',
    `         projectKey: ${src.projectKey}`,
    `         targetKey:  ${src.key}`,
    '         reason:     the SAME text as your step-3 comment',
    '',
  ];
  if (src.runnerPostsAgentReport !== true) {
    return [
      '  4. Report it with the report_unbuildable_target tool:',
      ...call,
      '     It spends nothing. It is safe to repeat: the server keeps one record per',
      '     run. It returns nothing to act on.',
    ];
  }
  return [
    '  4. Report it. If the environment variable MOTIR_AGENT_REPORT is set, put the',
    '     SAME text as your step-3 comment into the JSON file at that path, as',
    '     "unbuildable" beside "model":',
    '',
    '         {"model": "<as above>", "unbuildable": "<the SAME text as your step-3 comment>"}',
    '',
    '     and the run makes the report for you when you exit — no Motir tool needed.',
    '     If the variable is unset, report it with the report_unbuildable_target tool:',
    ...call,
    '     Either way it is one report. It spends nothing. It is safe to repeat: the',
    '     server keeps one record per run. It returns nothing to act on.',
  ];
}

/**
 * A STOP WITH NO MOTIR TOOLS (MOTIR-8722, `run-found-trigger-dispatched-path.md` AMENDMENT 2).
 *
 * Every write the STOP branch asks for — the comment, the move to Planning, the plan turn and
 * the submit — is a Motir MCP call, and a hosted run's agent and an agent-instance run's agent
 * have none (`AGENT_RUN_WITHHELD_ENV`; `/api/mcp` refuses a run token). So the agent puts them
 * into `$MOTIR_AGENT_REPORT` as `stop`, and the CLI makes the comment and the move with the
 * run's credential (`POST /api/v1/dispatch-runs/{id}/stop`).
 *
 * ⚠️ THE RE-PLAN IS NOT SUBMITTED ON THIS PATH, AND THE TEXT SAYS SO. A run's credential holds
 * no `ai:*` key by decision (`HOSTED_RUN_TOKEN_GRANT`), and submitting is the act that spends
 * the owner's credits; the brief is kept on the card for the person who submits it. An agent
 * told the re-plan went out would report a submit nobody made.
 */
function noToolsStop(policy: FindingsPolicy): string[] {
  const head = [
    '  NO MOTIR TOOLS? If the Motir tools are not available to you (a hosted run, or',
    '  a run inside an agent, gives you none), you cannot write the step-3 comment',
  ];
  if (!policy.replan) {
    return [
      ...head,
      '  yourself. With MOTIR_AGENT_REPORT set, add "stop" to the same JSON file:',
      '',
      '         {"model": "…", "unbuildable": "<your step-3 comment>", "stop": {"toPlanning": false}}',
      '',
      '  and the run comments the card with your "unbuildable" text when you exit.',
      '  Then stop as below, leaving the card In Progress.',
    ];
  }
  return [
    ...head,
    '  or make the Planning, planning-thread and submit calls below yourself. With',
    '  MOTIR_AGENT_REPORT set, add "stop" to the same JSON file, with the six',
    '  requirement fields step 7 describes:',
    '',
    '         {"model": "…", "unbuildable": "<your step-3 comment>",',
    '          "stop": {"toPlanning": true, "requirement": {"outcome": "…", "behaviour": "…",',
    '                   "scopeEdge": "", "constraints": "", "acceptance": "…", "assumptions": ""}}}',
    '',
    '  When you exit, the run comments the card with your "unbuildable" text, moves',
    '  it to Planning and keeps your requirement on the card. It does NOT submit the',
    "  re-plan: a run's own credential cannot start planning, so a person submits it",
    '  from the card, and the comment says so. Do not report a re-plan as submitted.',
    '  Then stop. Do not pick up other work.',
  ];
}

/**
 * THE TWO LANES a re-plan can go down, when this run has one (MOTIR-4085).
 *
 * Renders NOTHING without `--auto-approve-replan`, which is what keeps the
 * default prompt byte-identical to the one that shipped: a run with no loop to
 * continue into has one lane, and describing two would be describing a choice
 * that does not exist.
 *
 * ── IT IS INFORMATION, NOT PRESSURE, and the difference is the whole design ──
 * An agent that is FORCED down the fast lane has an incentive to invent a local
 * fix it does not believe in — papering over a mis-planned story so the run can
 * continue — which buys continuity by spending plan quality. So the block says
 * both lanes are legitimate, says the normal one is always available, and says
 * out loud that stopping is a correct outcome. The one thing it must never
 * suggest is that a wider finding should be narrowed to fit.
 *
 * ── IT IS NOT THE BOUND EITHER ──────────────────────────────────────────────
 * Nothing here is trusted. The LOOP reads the plan that comes back, checks the
 * lane itself, and approves or does not — so an agent that ignores every word of
 * this cannot cause an approval, and one that misjudges the lane is stopped by
 * name rather than obeyed. What the block buys is that the agent knows which
 * choice it is making, and that a deliberate reach beyond the lane is a decision
 * rather than an accident.
 *
 * ── THE ANCHOR IS THE ELECTION ──────────────────────────────────────────────
 * `approveWorkItemPlan` resolves the plan through the conversation anchored at
 * THIS card's key and nothing else, so a plan anchored anywhere else is
 * structurally out of the loop's reach: the run stops and a person decides. That
 * is a property of the shipped resolution rather than a rule this text invents,
 * which is why the block can state it as a fact.
 */
function twoLanes(src: DispatchPromptSource, policy: FindingsPolicy): string[] {
  if (!policy.autoApproveReplan) return [];
  const parent = src.parent?.key ?? null;
  const siblingLevel = parent
    ? `${src.key} and its siblings under ${parent}`
    : `${src.key} itself — it has no parent, so it has no sibling level either`;
  return [
    '',
    '  ── TWO LANES, and WHICH ONE is yours to choose ─────────────────────────',
    '',
    '  This run was launched with --auto-approve-replan: its loop may approve a',
    '  re-plan itself and carry on, instead of stopping for a person. It approves',
    '  inside ONE lane, and it checks that lane over the plan that comes back — so',
    '  you cannot ask for automatic approval and you cannot be given it by',
    '  accident. Nothing below changes what you may do; it tells you what happens',
    '  to what you submit, which you have no other way to find out.',
    '',
    `    THE CARD'S OWN LANE — the correction is ${siblingLevel}:`,
    '    a rewrite, a split into two siblings, an added sibling, a sibling that',
    '    should not exist. Keep targetKeys at the value steps 6 and 7 show and the',
    '    loop may approve it, then carry on with the corrected work.',
    '',
    '    THE NORMAL LANE — everything wider, and it is ALWAYS available, including',
    '    right now. Put the CONTAINER’s key in targetKeys instead — in BOTH calls,',
    parent
      ? `    steps 6 and 7, e.g. [${parent}] — when the mis-planning is bigger than`
      : '    steps 6 and 7 — when the mis-planning is bigger than',
    '    this one card; or omit targetKeys entirely when what is missing is a',
    '    precondition no card names yet, and the planner will settle a new one.',
    '    A person reviews the plan, and this run stops.',
    '',
    '  CHOOSE THE LANE THAT IS TRUE. If the whole story is mis-planned, say so and',
    '  let the run stop — a stop a person can act on beats a local fix you do not',
    '  believe in. You are not being asked to keep the run going.',
    '',
    `  And if you anchor here but propose beyond ${parent ? `${parent}'s children` : "this card's own level"},`,
    '  the loop does not approve it: it names what fell outside and stops, and the',
    '  plan waits for a person. That is a correct outcome — it is',
    '  not a rejection of your finding, and nothing you wrote is lost.',
    '',
  ];
}

/**
 * The six fields of the WHAT, as the prompt teaches them — NAME, whether the far
 * side requires it non-empty, and what the agent is being asked for.
 *
 * ⚠️ THE NAMES AND THE ORDER ARE motir-ai's, NOT THIS FILE's. `REQUIREMENT_FIELDS`
 * in `src/jobs/conversation.ts` declares them in this order and
 * `REQUIREMENT_REQUIRED_NON_EMPTY` names the three; `submit_plan_session`'s
 * schema (`lib/mcp/tools/planSession.ts`) declares them in the same order. A
 * rename on any of the three sides fails `tests/dispatch/promptTemplate.test.ts`,
 * which reads the composed prompt against the fixture that mirrors motir-ai's
 * list — a prompt asserted only against itself is what let MOTIR-4168 through.
 *
 * `assumptions` is translated for THIS actor. Its own definition reads *"what the
 * planner recommended and nobody corrected"* — written from a conversation's
 * point of view, where a person is present to not-correct it. A dispatched agent
 * has neither, so here it means what the agent concluded that nobody confirmed.
 */
function requirementBrief(): string[] {
  const fields: { name: string; required: boolean; ask: string[] }[] = [
    {
      name: 'outcome',
      required: true,
      ask: ['what the corrected card should make possible', 'that it does not today'],
    },
    {
      name: 'behaviour',
      required: true,
      ask: [
        'what you expected versus what you actually',
        'found, observably: the file, the command, what it said',
      ],
    },
    {
      name: 'scopeEdge',
      required: false,
      ask: [
        'what you are deliberately NOT asking for; "" says you',
        'considered it and there is none',
      ],
    },
    {
      name: 'constraints',
      required: false,
      ask: [
        'what already binds the shape — a shipped decision, a',
        'boundary the corrected card must respect; "" if none',
      ],
    },
    {
      name: 'acceptance',
      required: true,
      ask: [
        'how the planner will know the corrected card',
        'is right, as something a reader can observe',
      ],
    },
    {
      name: 'assumptions',
      required: false,
      ask: ['what you concluded that nobody has confirmed; "" if', 'nothing'],
    },
  ];
  const lines: string[] = [];
  for (const f of fields) {
    const [first, ...rest] = f.ask;
    const head = f.required ? `REQUIRED — ${first}` : first;
    lines.push(`           ${f.name.padEnd(12)} ${head}`);
    for (const line of rest) lines.push(`                        ${line}`);
  }
  return lines;
}

/**
 * The THIRD branch: your card is fine, and something ELSE is broken.
 *
 * ⚠️ ITS FIRST JOB IS TO SAY IT IS NOT AN ENDING. An agent that has just found
 * something broken treats it as a reason to stop unless told otherwise, and a run
 * that abandoned a perfectly good card over a side-finding would be worse than
 * one that never looked.
 *
 * ⚠️ AND THE PARENT IS A KEY, NOT A RULE TO APPLY. The ADR's Q3 settles it — the
 * bug is parented under the in-flight card's PARENT — and the parent key is
 * already on the dispatch payload, so the text names it outright. An agent asked
 * to file something "in a sensible place" invents a place.
 */
function foundADefect(src: DispatchPromptSource, policy: FindingsPolicy): string[] {
  const heading = [
    '',
    'FOUND A DEFECT — your card is fine, and something ELSE is broken. This is NOT',
    'an ending: it does not finish your card, it does not fail it, and it does not',
    'change which of the two outcomes above you report. You record what you found',
    'and CARRY ON with the card in hand. It applies during a BUILD THROUGH as well,',
    'and filing a bug never turns a build-through into STOP.',
    '',
  ];

  // The switch. Nothing renders in place of the branch's instructions except the
  // alternative: a comment. The finding must still reach a human — a policy that
  // turned filing off was never asking the agent to forget what it saw.
  if (!policy.logBug) {
    return [
      ...heading,
      `  This run was launched without bug filing, so do NOT create a work item.`,
      `  Comment the finding on ${src.key} instead: what is broken, how to make it`,
      '  happen, and the evidence — the command you ran and what it printed. Then',
      '  continue with your card.',
    ];
  }

  // The parent is the card's own parent; a top-level card is its own parent for
  // this purpose, because a bug with no parent lands at the project root where
  // nobody triaging this area will meet it.
  const parentKey = src.parent?.key ?? src.key;
  const parentNote = src.parent
    ? `${parentKey} — the parent of ${src.key}, the card you are working`
    : `${parentKey} — the card you are working, which has no parent of its own`;

  return [
    ...heading,
    '  1. REPRODUCE IT FIRST. Make the defect happen before you write a word about',
    '     it. A bug filed from reading the code is a claim, not an observation, and',
    '     it costs whoever picks it up the same investigation a second time.',
    '  2. File it with the create_work_item tool:',
    '',
    "         kind:      'bug'",
    `         parentKey: ${parentKey}`,
    '',
    `     That parent is not a choice: it is ${parentNote}.`,
    '     Do not look for a better home and do not invent one.',
    '  3. Its description OPENS with this exact line — copy it, do not reword it:',
    '',
    `         **Found while:** running ${src.key}`,
    '',
    '     and on that same line, or the one right after it, the branch or commit',
    '     you were on. A number measured on an unmerged branch is not a number',
    '     about main, and saying which is the difference between a report and a',
    '     rumour. Then, in this order:',
    '        - THE REPRODUCTION — what to do to make it happen.',
    '        - THE EVIDENCE — the command you ran and its output verbatim, or the',
    '          file and line you read.',
    `  4. Link it back: link_work_items, relationship relates_to, to ${src.key}.`,
    '     The parent says where the bug LIVES; this says where it was FOUND. It',
    '     is idempotent, and it usually IS a no-op: naming the card in step 3',
    '     already creates that edge. A "already linked" answer is success.',
    '  5. It BLOCKS NOTHING. No blocked_by edge, no sprint, no estimate. Filing is',
    '     purely additive — it claims no scope and holds nothing up — and that is',
    '     what makes it safe for an unattended run to do at all.',
    '  6. Carry on with your card and report its own outcome as above.',
  ];
}

/**
 * ONE CARD, ONE COMMIT — and what that commit message is FOR (MOTIR-2406).
 *
 * `motir auto` runs every card onto one session branch and opens ONE pull
 * request at close-out, whose body is assembled from the commits on that branch
 * (11.5.27). So the message is not bookkeeping: it is the only per-card
 * narrative that reaches a reviewer, and nobody reading the pull request opens
 * the card.
 */
function commitContract(src: DispatchPromptSource): string[] {
  return [
    '',
    'YOUR COMMIT',
    '',
    `  ONE commit for ${src.key}, and only if the work is finished. A run puts many`,
    '  cards on one branch and a reviewer reads the pull request as the list of',
    '  cards it delivers — a commit with no card behind it, from an agent that got',
    '  halfway and committed anyway, is worse than either finishing or stopping.',
    '',
    '  ⚠️ THE MESSAGE BECOMES THE PULL REQUEST. The run assembles its pull-request',
    '  body from these commit messages, so write yours for a REVIEWER WHO WAS NOT',
    '  THERE and who will not open the card. Subject: what changed. Body: why, and',
    '  whatever they need in order to decide whether to merge — including what',
    '  surfaced while you worked that the card could not have known. A subject that',
    '  restates the card title tells them nothing they cannot already see, and a',
    '  one-liner leaves the pull request with a heading and no reasoning under it.',
  ];
}

/** Indent every line of a possibly multi-line value, so a long message stays
 *  inside its block instead of reading as the prompt's own text. */
function indentBlock(text: string, pad: string): string[] {
  return text.split(/\r?\n/).map((line) => `${pad}${line}`);
}

/**
 * The ERROR EVIDENCE section (Story MOTIR-5975 · Subtask MOTIR-5982): what the
 * monitor recorded for each error linked to this work item, so an agent handed a
 * monitor-filed bug starts from the exception, the stack and the request rather
 * than from a one-line title. A dispatched agent reads THIS prompt and nothing
 * else — it never opens the item page.
 *
 * ⚠️ IT IS A RENDERING OF STORED FACTS, like the design reference. It fetches
 * nothing, never re-derives `evidence.state`, and cuts nothing below the store's
 * own bounds. The tags were filtered at the provider seam, so there is no second
 * filter here — a second home for the denylist is one that drifts.
 *
 * ⚠️ AN EMPTY LIST RENDERS NOTHING — not a heading, not a blank line — so a work
 * item with no link gets the prompt it always got.
 */
export function renderErrorEvidence(links: readonly MonitorIssueLinkDto[]): string[] {
  if (links.length === 0) return [];
  const lines: string[] = [
    'What the error monitor recorded for the errors linked to this work item — read',
    'from Motir, never live from the monitor. Start your diagnosis here. Tags have had',
    'every user-identifying key removed; the request is a method and a path only.',
  ];
  links.forEach((link, index) => {
    const { evidence } = link;
    const where = [link.connection.orgSlug, link.connection.projectSlug].filter(Boolean).join('/');
    lines.push(
      '',
      `Error ${index + 1} of ${links.length}: ${link.title}`,
      `  ${[
        link.level ?? 'unknown level',
        `seen ${link.eventCount} time${link.eventCount === 1 ? '' : 's'}`,
        link.environment ? `environment ${link.environment}` : null,
        link.release ? `release ${link.release}` : null,
        where ? `monitor ${where}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}`,
    );
    if (evidence.state === 'never_read') {
      lines.push(
        '  The latest event has not been read yet, so there is no evidence to show — it',
        '  arrives on a later check. Do not read its absence as "the error has no stack".',
      );
      return;
    }
    if (evidence.stale) {
      lines.push(
        `  OUT OF DATE: the last check of this error failed at ${evidence.lastFailedAt}.`,
        `  What follows was read at ${evidence.readAt} and may be older than the error now is.`,
      );
    }
    if (evidence.exception) {
      const head = evidence.exception.type ?? 'Exception';
      if (evidence.exception.message) {
        lines.push(`  Exception: ${head}`, ...indentBlock(evidence.exception.message, '    '));
      } else {
        lines.push(`  Exception: ${head}`);
      }
    } else {
      lines.push('  No exception: the latest event carried no exception and no stack.');
    }
    if (evidence.frames.length > 0) {
      lines.push('  Stack frames (the application’s own first, then most recent call first):');
      for (const frame of evidence.frames) {
        const at =
          frame.lineNumber === null ? frame.filePath : `${frame.filePath}:${frame.lineNumber}`;
        const fn = frame.function ? ` ${frame.function}` : '';
        lines.push(`    ${frame.inApp === true ? '[app] ' : '      '}${at}${fn}`);
      }
    }
    if (evidence.tags.length > 0) {
      lines.push('  Tags:');
      for (const tag of evidence.tags) lines.push(`    ${tag.key} = ${tag.value}`);
    }
    if (evidence.request) {
      lines.push(
        `  Request: ${[evidence.request.method, evidence.request.path].filter(Boolean).join(' ')}`,
      );
    }
    lines.push(
      `  Event: ${evidence.eventId ?? 'id not recorded'}${evidence.eventAt ? ` at ${evidence.eventAt}` : ''}`,
    );
  });
  return lines;
}

/** The closing note a MANUAL item gets in place of a GIT WORKFLOW section. */
const MANUAL_CLOSING = [
  'There is no git workflow for this work item: it is human work with no branch and',
  'no pull request. When it is complete, say so — that confirmation is what moves it',
  'to Done and releases the work items waiting on it.',
];

/**
 * Assemble the canonical dispatch prompt for a work item.
 *
 * Deterministic and total: every input shape yields a prompt (an untyped item, a
 * body with no acceptance criteria, an unknown repo, a manual item). See the
 * module header for the three axes that vary and where each is decided.
 */
/**
 * WHICH `GIT WORKFLOW` variant this item gets — a 2×2 over the lineage and the
 * repository COUNT (`docs/decisions/dispatch-prompt-assembly.md`, *What varies,
 * and who decides*).
 *
 * Fewer than two repositories takes the shipped single-repository text, byte for
 * byte: that is the whole back-compatibility promise of MOTIR-3132, and putting
 * the choice in one function is what makes it checkable rather than asserted.
 */
/**
 * The CONTINUE GIT WORKFLOW (MOTIR-6531) — CHECK OUT the dead run's branch, never
 * cut one. Selected whenever the prompt continues a dead run, for a per-item card
 * and a lineage card alike (a lineage card keeps integrating into its session
 * branch). The branch the agent works on is the whole difference between
 * continuing and starting over, and the agent only knows what this says: a prompt
 * that still told it to branch from main would undo the resume (MOTIR-6322).
 */
function continueWorkflow(
  src: DispatchPromptSource,
  cf: ContinueFromForPrompt,
  sessionBranch: string | null,
): string[] {
  const repos = continueRepoSet(cf);
  if (repos) return multiRepoContinueWorkflow(src, repos, sessionBranch);
  const branch = cf.branch;
  const dir = worktreeDir(src.targetRepo, src.key);
  const base = sessionBranch ?? 'main';
  const lines = [
    `This is a CONTINUE: the work is already on ${branch}. Check that branch out —`,
    'never create a new one.',
    '',
    '1. git fetch origin',
    `2. If the worktree ${dir} already exists and is on ${branch}, use it. Otherwise:`,
    `   git worktree add ${dir} ${branch}`,
    `   (it tracks origin/${branch}; this checks the EXISTING branch out).`,
    `3. cd ${dir}, install dependencies, and read \`git log origin/${base}..HEAD\` and`,
    '   `git status` BEFORE changing anything.',
    `4. git merge origin/${base}, and resolve any conflict.`,
    '5. Finish the work. Stage with explicit `git add <path>` — never `-A`.',
    `6. Commit with a Conventional Commits subject that carries ${src.key}.`,
    ...checkpointLines(branch),
  ];
  if (sessionBranch !== null) {
    return [
      ...lines,
      `7. Integrate the commit into ${sessionBranch} and push that branch.`,
      `8. Report it: call the mark_integrated tool with key ${src.key} and`,
      `   sessionBranch ${sessionBranch}.`,
      '9. Do NOT open a pull request of your own. The session pull request from',
      `   ${sessionBranch} usually already exists (\`gh pr list --head ${sessionBranch}\`);`,
      '   open it only if it does not.',
      ...linkingStep(src, sessionBranch, 10),
      '11. STOP. Do not merge that pull request and do not delete the branch.',
    ];
  }
  return [
    ...lines,
    `7. Push ${branch}. Open a pull request against main ONLY if none is open for it`,
    `   (\`gh pr list --head ${branch}\`) — a continue never opens a second one. Put`,
    `   ${src.key} in the TITLE as well, as a label.`,
    ...linkingStep(src, branch, 8),
    '9. STOP at the open pull request. Do not merge it and do not delete the branch.',
  ];
}

/**
 * The MULTI-repository CONTINUE GIT WORKFLOW (MOTIR-6791) — the dead run pushed
 * a branch in EACH repository, so each is checked out, brought up to date,
 * finished and delivered: one pull request per repository (reusing an open one),
 * or, for a leg of a parent run, integrated into that repository's session
 * branch. Keeping only the first repository's branch — what this replaced —
 * silently dropped the others' work.
 */
function multiRepoContinueWorkflow(
  src: DispatchPromptSource,
  repos: ContinueFromBranch[],
  sessionBranch: string | null,
): string[] {
  const baseOf = (repository: string | null): string =>
    sessionBranch ??
    (src.targetRepos ?? []).find((r) => r.name === repository)?.defaultBranch ??
    'main';
  const lines: string[] = [
    `This is a CONTINUE across ${repos.length} repositories: the work is already on a`,
    'branch in EACH of them. Check every one out — never create a new branch.',
  ];
  repos.forEach((entry, i) => {
    const name = entry.repository ?? '<repo>';
    const wt = worktreeDir(entry.repository, src.key);
    const base = baseOf(entry.repository);
    lines.push(
      '',
      `${name}${i === 0 ? '  (your working directory)' : '  (a sibling checkout)'}`,
      '',
      `  1. cd ${siblingDir(name, i)} && git fetch origin`,
      `  2. If the worktree ${wt} already exists and is on ${entry.branch}, use it. Otherwise:`,
      `     git worktree add ${wt} ${entry.branch}`,
      `     (it tracks origin/${entry.branch}; this checks the EXISTING branch out).`,
      `  3. cd ${wt}, install dependencies, and read \`git log origin/${base}..HEAD\` and`,
      '     `git status` BEFORE changing anything.',
      `  4. git merge origin/${base}, and resolve any conflict.`,
      "  5. Finish THIS repository's share of the work. Stage with explicit",
      '     `git add <path>` — never `-A`.',
      `  6. Commit with a Conventional Commits subject that carries ${src.key}.`,
      ...checkpointLines(entry.branch, '  '),
      ...(sessionBranch !== null
        ? [`  7. Integrate the commit into ${sessionBranch} and push that branch.`]
        : [
            `  7. Push ${entry.branch}. Open a pull request against ${base} ONLY if none is open`,
            `     for it (\`gh pr list --head ${entry.branch}\`)` +
              (entry.pullRequest ? ` — #${entry.pullRequest.number} is.` : '.'),
            `     Put ${src.key} in the TITLE as well, as a label.`,
            ...linkingStep(src, entry.branch, 8, {
              indent: '  ',
              baseRef: base,
              trailer: [
                'ONCE PER REPOSITORY — each repository has its own pull request, so each',
                'needs its own call; the item completes only when they have all merged.',
              ],
            }),
          ]),
    );
  });
  if (sessionBranch !== null) {
    lines.push(
      '',
      `Then report it ONCE: call the mark_integrated tool with key ${src.key} and`,
      `sessionBranch ${sessionBranch}. Do NOT open a pull request of your own; in EACH`,
      'repository, find the session pull request (`gh pr list --head ' + sessionBranch + '`),',
      'open it only if it does not exist, and:',
      ...linkingStep(src, sessionBranch, 1, {
        trailer: ['ONCE PER REPOSITORY.'],
      }),
      '',
      'STOP. Do not merge any pull request and do not delete any branch.',
    );
  } else {
    lines.push(
      '',
      `STOP at the ${repos.length} open pull requests — one per repository. Do not merge any`,
      'of them and do not delete any branch.',
    );
  }
  return lines;
}

function gitWorkflow(src: DispatchPromptSource, sessionBranch: string | null): string[] {
  if (src.continueFrom) return continueWorkflow(src, src.continueFrom, sessionBranch);
  const repos = multiRepoSet(src);
  if (sessionBranch !== null) {
    return repos
      ? multiRepoSessionLineageWorkflow(src, repos, sessionBranch)
      : sessionLineageWorkflow(src, sessionBranch);
  }
  return repos ? multiRepoPerItemPrWorkflow(src, repos) : perItemPrWorkflow(src);
}

/** The ERROR EVIDENCE section with its trailing separator, or nothing at all. */
function errorEvidenceBlock(links: readonly MonitorIssueLinkDto[]): string[] {
  const body = renderErrorEvidence(links);
  return body.length === 0
    ? []
    : [...section('ERROR EVIDENCE — what the monitor recorded for this work item', body), ''];
}

/** Each content language's English name, for the WORK CONTENT LANGUAGE section. */
const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
};

/**
 * The WORK CONTENT LANGUAGE section with its trailing separator (MOTIR-8745), or
 * nothing when no language was passed or the item is MANUAL. A FACT stated to the
 * agent, not an instruction to translate: the MCP door already records the
 * organisation's language on what the agent writes.
 */
function contentLanguageBlock(src: DispatchPromptSource, manual: boolean): string[] {
  const code = src.contentLanguage;
  if (manual || code === undefined) return [];
  return [
    ...section('WORK CONTENT LANGUAGE', [
      `This organisation writes its work content in ${LANGUAGE_NAMES[code]} (\`${code}\`).`,
      'Any work item or to-do you write through Motir — a bug you file, an item you',
      'create, a to-do you add — has its title, description, acceptance criteria,',
      `explanation, and to-do text and notes written in ${LANGUAGE_NAMES[code]}, whatever`,
      'language this card or the conversation is in.',
      'Identifiers, file paths, code, commands, work item keys and quoted text keep',
      'their original form.',
      'The MCP door records that language for you: pass no language yourself unless',
      'you deliberately write a field in another one.',
    ]),
    '',
  ];
}

export function assembleDispatchPrompt(src: DispatchPromptSource): AssembledDispatchPrompt {
  const injections = src.injections ?? NO_INJECTIONS;
  const { body, acceptanceCriteria, contextRefs } = splitPlanBody(src.descriptionMd);
  const manual = isManualReadyItem({ type: src.type, executor: src.executor });
  // The lineage the prompt instructs. A manual item is forced to `per_item_pr`
  // with no branch — it renders no GIT WORKFLOW at all (see the interface doc).
  // So is an agent's DECISION card, which renders no GIT WORKFLOW either: it
  // writes a page and publishes it, with no branch (MOTIR-7437, superseding
  // MOTIR-6094's own-pull-request rule; {@link isAgentDecisionItem}). Decided
  // HERE, not by the CLI, because a lineage can be inherited from a blocker as
  // well as seeded, and every lane that dispatches reads this answer.
  const agentDecision = !manual && isAgentDecisionItem(src);
  const sessionBranch = manual || agentDecision ? null : src.sessionBranch;
  const workflowMode: DispatchWorkflowMode =
    sessionBranch !== null ? 'session_lineage' : 'per_item_pr';

  const header = [
    `You are working on the ${src.projectName} project.`,
    `You are executing ${humanize(src.kind)} ${src.key}: ${src.title}.`,
  ];
  if (manual) {
    header.push(
      '',
      'This is a MANUAL work item: a person does it, not a coding agent. The steps',
      'below are instructions for that person.',
    );
  }

  let whatToDo = UNTYPED_WHAT_TO_DO;
  if (manual) whatToDo = MANUAL_WHAT_TO_DO;
  else if (src.type) whatToDo = WHAT_TO_DO[src.type];
  whatToDo = withConventionStep(whatToDo, src);
  // The acceptance-receipt steps (MOTIR-4704) — appended, never substituted: an
  // acceptance card still writes and greens its spec, and the publish is the
  // step AFTER that. A manual item is excluded by construction (it took
  // MANUAL_WHAT_TO_DO above and has no run to record anything in).
  if (!manual && recordsAcceptanceReceipt(src)) {
    whatToDo = [...whatToDo, ...ACCEPTANCE_PUBLISH_STEPS];
  }
  // The design-result step (MOTIR-5495) — appended, and chosen by the server's
  // answer rather than by the card: publish when work waits, say not to when none
  // does. A manual item never reaches it.
  if (!manual && src.type === 'design') {
    whatToDo = [...whatToDo, ...designResultSteps(src.openDependentKeys)];
  }
  // The bug-card reproduction preamble (MOTIR-5944) — keyed on KIND, for any
  // type, and prepended so it is read before the type's steps and before THE
  // CARD IS WRONG. A manual item is excluded: it has no pull request body for
  // the matrix and no outcome protocol for step d to point at.
  if (!manual && src.kind === 'bug') {
    whatToDo = [...BUG_REPRODUCTION_STEPS, ...whatToDo];
  }

  // A MANUAL item gets neither the git workflow nor the outcome protocol: it is
  // human work with no branch, no commit and no MCP session, and `motir auto`
  // skips it entirely. Its closing note already says how to report completion.
  let closing = MANUAL_CLOSING;
  if (agentDecision) {
    // An agent's DECISION card (MOTIR-7437) writes a page and publishes it: no
    // branch, no commit and no pull request, so no GIT WORKFLOW — a block that would
    // contradict WHAT TO DO step 5 — and an outcome protocol whose FINISHED is the
    // publish.
    closing = section(
      'REPORTING THE OUTCOME — say which one happened',
      decisionOutcomeProtocol(src),
    );
  } else if (!manual) {
    closing = [
      // Every prompt that builds something tells the agent to report its steps
      // (MOTIR-7501). A MANUAL item builds nothing an agent runs, so it is absent.
      ...section('REPORTING YOUR STEPS', stepReporting(src.key)),
      '',
      ...section('GIT WORKFLOW', [...gitWorkflow(src, sessionBranch), ...commitContract(src)]),
      '',
      // LAST, deliberately. The protocol is what the agent does at the end of
      // the work, and the last thing in a prompt is the thing it is holding when
      // it starts acting. Placing it earlier would leave the git workflow as the
      // final word, which is how "set the card to Implemented" becomes the step
      // that gets forgotten.
      ...section(
        'REPORTING THE OUTCOME — say which one happened',
        outcomeProtocol(src, sessionBranch),
      ),
    ];
  }

  const lines = [
    ...header,
    '',
    ...section('CONTEXT', contextSection(src, body, contextRefs, injections)),
    '',
    // The WORK CONTENT LANGUAGE (MOTIR-8745) sits between the card's context and
    // its steps, and renders NOTHING when the caller passed no language.
    ...contentLanguageBlock(src, manual),
    ...section('WHAT TO DO', whatToDo),
    '',
    ...section('ACCEPTANCE CRITERIA — every one must hold', acceptanceSection(acceptanceCriteria)),
    '',
    // The ERROR EVIDENCE (MOTIR-5982) sits with the card's own WHAT — after its
    // criteria, before the git workflow — and renders NOTHING for a card with no
    // monitor link, so every other prompt is byte-identical to before.
    ...errorEvidenceBlock(src.errorEvidence ?? []),
    ...closing,
  ];

  const branchless = manual || agentDecision;
  const branch = branchless ? null : (src.continueFrom?.branch ?? sessionBranch ?? cardBranch(src));
  return {
    prompt: lines.join('\n') + '\n',
    workflowMode,
    sessionBranch,
    workBranch: branchless ? null : cardBranch(src),
    branch,
  };
}
