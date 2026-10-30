import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planValidityService } from '@/lib/services/planValidityService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  isCoverageAdvisory,
  isTitleCoverageAdvisory,
  isBlockerCountAdvisory,
  isPathReferenceAdvisory,
  isOrderingAdvisory,
  isReferenceAdvisory,
  isRepoStraddleAdvisory,
  isBodyAboveFieldMoveAdvisory,
  isSelfBlockingDesignAdvisory,
  isSizingAdvisory,
  isUnderAuthoredAdvisory,
  isMislabelledLinkAdvisory,
  isPostMergeChildAdvisory,
  isSubsumptionAdvisory,
} from '@/lib/dto/workItems';
import {
  BODY_ABOVE_FIELD_MOVE_REMEDY,
  describeBodyAboveFieldMove,
} from '@/lib/workItems/bodyAboveFieldMove';
import type {
  WorkItemProseMislabelledLinkAdvisoryDto,
  WorkItemValidityAdvisoryDto,
  WorkItemValidityDto,
} from '@/lib/dto/workItems';
import type { ValidityCondition } from '@/lib/dto/sprints';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { conditionField } from './sprintRef';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';
import { TEMP_REF_HELP, normalizeProjectedTarget, planIdField } from './planRef';

// `validate_work_item` (Story 7.8 · Subtask 7.8.23) — is a work item FINISHABLE?
// The single-item analogue of `validate_sprint`, with the target's SUBTREE
// (the item + all its descendants) standing in for the sprint. The target may
// be any non-leaf kind — epic / story / task / bug. VALID ⟺ every not-done item
// in the subtree has its `blocked_by` closure satisfied: each dependency is IN
// the subtree (the target's own work — never gates), or — under `loose` — done.
//
// `condition` (shared with `validate_sprint`, MOTIR-1374) tunes the
// out-of-subtree `done` case: `loose` (default) accepts a done dependency
// anywhere; `tight` requires it to be IN the subtree, else it is reported.
//
// `planId` (MOTIR-3095) switches the same question onto the PROJECTED tree —
// the project's live tree ⊕ that plan's `PlanItem` delta — so an agent can
// validate a subtree it has PROPOSED before anybody reviews it. The target may
// then be a `planItem:<id>` temp-ref as well as a committed key, which is the
// case an authoring agent usually has. OMITTING `planId` never reaches the
// projection at all, so an existing caller's result is unchanged by
// construction rather than by test:
// `docs/decisions/agent-authored-plans.md` AMENDMENT 3, Q5–Q8.
//
// A thin READ adapter over `workItemsService.validateWorkItem` /
// `planValidityService.validateProjectedWorkItem` — no business logic here; the
// subtree walk + the validity rule live in the service, and the projected mode
// runs the SAME rule over a different node set. READ scope
// (`lib/mcp/scopes.ts`), like `validate_sprint` / `get_work_item`: the plan is
// read through `plansService.getPlan`, which asserts browse on the same
// project, so the projected reach is the reach of the two calls it replaces.

export const VALIDATE_WORK_ITEM_TOOL_NAME = 'validate_work_item';

const inputSchema = {
  key: workItemKeyField.describe(
    'The work item to validate — the project key, a dash, the number (e.g. "ACME-7"), ' +
      'case-insensitive. With `planId`, this may instead be a `planItem:<id>` temp-ref ' +
      'naming an `add` in that plan (case-SENSITIVE, as `add_plan_items` returned it).',
  ),
  condition: conditionField,
  planId: planIdField,
};

interface ValidateWorkItemArgs {
  key: string;
  condition?: ValidityCondition;
  planId?: string;
}

/**
 * The prose-vs-graph advisory lines (MOTIR-1969), appended to EITHER verdict.
 * Deliberately phrased as a prompt to look, never as a failure: advisories do
 * not change `valid`, so a VALID item with advisories is still VALID.
 */
function advisoryLines(result: WorkItemValidityDto): string[] {
  return advisoryBlockLines(
    result.advisories,
    `NOT a blocker — ${result.key} is ${result.valid ? 'still VALID' : 'unaffected'} either way`,
  );
}

/**
 * The advisory blocks for any advisory list, one block per family with its
 * remedy. Exported for `validate_plan`, which reports the SHAPE families over a
 * plan's proposals (MOTIR-10087) in the same words this verdict uses for one
 * card. `unaffected` is the caller's "not a blocker" clause — the two verdicts
 * phrase it differently.
 */
export function advisoryBlockLines(
  advisories: readonly WorkItemValidityAdvisoryDto[],
  unaffected: string,
): string[] {
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
  const mislabelled = advisories.filter(isMislabelledLinkAdvisory);
  const postMerge = advisories.filter(isPostMergeChildAdvisory);
  const uncovered = advisories.filter(isCoverageAdvisory);
  const unnamedTitles = advisories.filter(isTitleCoverageAdvisory);
  const pathReferences = advisories.filter(isPathReferenceAdvisory);

  const lines: string[] = [];
  for (const a of underAuthored) {
    lines.push(
      '',
      `Advisory (${unaffected}): ${a.item} is UNDER-AUTHORED — ${
        a.criteria === 'no-heading'
          ? 'no `## Acceptance criteria` heading'
          : 'an `## Acceptance criteria` heading with no criterion under it'
      }, and null storyPoints, estimateMinutes, type and executor. Author it before sealing; every other check reads an empty list as clean.`,
    );
  }
  for (const a of blockerCounts) {
    lines.push(
      '',
      `Advisory (${unaffected}): ${a.item} claims "${a.claim}" (${a.claimedCount}), but its graph holds ${a.blockerCount} blocked_by edge${a.blockerCount === 1 ? '' : 's'}. Update the prose or the graph.`,
    );
  }
  lines.push(...mislabelledLinkLines(mislabelled, unaffected));
  // The POST-MERGE-CHILD member of the shape family (MOTIR-8863), rendered here
  // since `validate_plan` reports it over a plan's proposals (MOTIR-10087).
  for (const a of postMerge) {
    lines.push(
      '',
      `Advisory (${unaffected}): ${a.item} reads the deployment ("${a.phrase}") while it sits INSIDE ${a.container}, whose merge it waits on. Move it out to be a sibling of ${a.container} that ${a.container} blocks.`,
    );
  }
  if (references.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these items are NAMED in a card's description but have no ` +
        'blocked_by edge from it:',
      ...references.map(
        (a) =>
          `  ${a.item} names ${a.referenced} (${a.referencedStatus})` +
          `${a.severity === 'likely-missing-edge' ? ' IN ITS ACCEPTANCE CRITERIA — likely a missing blocked_by' : ''}`,
      ),
      'Wire a blocked_by edge if the card consumes it; ignore this if the reference is context only.',
    );
  }
  // The SHAPE family (MOTIR-2175) — a defect in what the card's own criteria ask
  // for, with no second item involved, so it gets its own block and its own
  // remedy rather than being squeezed into the sentence above.
  if (shapes.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards have an acceptance criterion that reads on state ` +
        "which exists only AFTER the card's own PR has merged — and a card's boundary ends at " +
        'PR opened:',
      ...shapes.map(
        (a) => `  ${a.item} criterion ${a.criterionIndex} says "${a.phrase}" (${a.severity})`,
      ),
      'Cut the card at that criterion: everything from it down belongs to a follow-on card, ' +
        'blocked_by this one (gate 14, ORDERING axis). A deploy / human card that legitimately ' +
        'needs the merge — the release trio\'s "cut" leg — is exempt and never reported here.',
    );
  }
  // The REPO-STRADDLE member of the same family (MOTIR-2177) — gate 1's repo
  // column, and a different remedy again: not "cut the card at this line" but
  // "split it per repo", so it gets its own block rather than being folded into
  // the ordering sentence above.
  if (straddles.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards have an acceptance criterion discharged in a repo ` +
        "that is not the card's own — one subtask, one repo, one pull request:",
      ...straddles.map(
        (a) =>
          `  ${a.item} criterion ${a.criterionIndex} names ${a.path} (${a.repo})` +
          (a.reason === 'contradiction'
            ? ', while the card pins a different targetRepo'
            : ', and the card pins no repo while its criteria name more than one — check whether ' +
              'it is UNPINNABLE rather than unpinned') +
          ` (${a.severity})`,
      ),
      'Split the card per repo (gate 1, the criterion-by-criterion repo column). Two knowingly ' +
        'uncovered forms remain: a BOUNDARY-CONTRACT card — a producer plus its mirrored ' +
        'consumer, two coordinated PRs, legitimately one card — is reported here and is an ' +
        'accepted false positive; and the bare-SYMBOL tell (a symbol whose repo you happen to ' +
        "know) is invisible to this check, so gate 1's prose still applies.",
    );
  }
  // The SIZING member of the shape family (MOTIR-3110) — THE ESTIMATION GATE,
  // and this surface is the one the gate's four misses each passed through
  // green. MOTIR-3068 was `valid: true` at 13 SP / 600 min with the split it
  // needed written out in its own description (`notes.html` #323); the number
  // was in a column nothing read, so this block reads it.
  if (oversized.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards are sized OVER the estimation gate — a ` +
        'coding_agent leaf splits at 8+ story points and its run must fit in 60 minutes (the ' +
        'MINUTES reading is a PROXY: the estimate column sums agent time and CI time, while the ' +
        'ceiling is on the agent run alone, so the threshold is 70 total minutes):',
      ...oversized.map(
        (a) =>
          `  ${a.item} is ${a.storyPoints ?? '—'} points / ${a.estimateMinutes ?? '—'} minutes ` +
          `(over: ${a.threshold === 'both' ? 'both ceilings' : a.threshold === 'story_points' ? 'story points' : 'estimate minutes'})` +
          ` (${a.severity})`,
      ),
      "SPLIT the card before it is dispatched — 8+ is the gate's literal split signal, and a " +
        'run longer than an hour is a card doing more than one thing. Writing "expect this to ' +
        'split" into the description is NOT the remedy: that is the exact shape this check ' +
        'exists to catch, four times over. A card with CHILDREN is sized by rollup and is never ' +
        'reported here, and neither is a human executor — its minutes are human work.',
    );
  }
  // The SELF-BLOCKING-DESIGN member of the shape family (MOTIR-3178) — the
  // planning-time design gate read for its purpose. MOTIR-3154 carried its own
  // `design/ai-planning/` amendment as criterion 1 and the UI built against that
  // drawing as criteria 4-5, and this surface returned `valid: true` with one
  // unrelated advisory (`notes.html` #329; planning bug MOTIR-3158).
  if (selfBlocking.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards are their OWN design blocker — one criterion draws ` +
        'the design, another builds the surface it draws:',
      ...selfBlocking.map(
        (a) =>
          `  ${a.item}: criterion ${a.designCriterionIndex} produces a design asset, ` +
          `criterion ${a.surfaceCriterionIndex} builds a rendered surface (${a.severity})`,
      ),
      'The remedy is a LIFT, not a cut: make the design criterion its OWN type: design card and ' +
        'leave the rest of this one blocked_by it, so somebody sees the drawing before the files ' +
        'written to match it (Principle #13). Read literally the design gate is satisfied here — ' +
        'the design subtask a UI card must be linked to IS this card — which is why a check says ' +
        'it rather than a sentence. A card with CHILDREN is never reported: its design child can ' +
        'be reviewed before its code children run, which is the shape this asks for.',
    );
  }
  // The BODY-EDIT-ABOVE-FIELD-MOVE member of the shape family (MOTIR-5399) — the
  // one read off a card's HISTORY. MOTIR-4513 was `valid: true` here with its body
  // describing the type one write had just moved it off (planning bug MOTIR-4577).
  if (bodyAbove.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards' bodies were last written AFTER their fields ` +
        'last moved, by a write that touched none of those fields:',
      ...bodyAbove.map((a) => `  ${describeBodyAboveFieldMove(a)} (${a.severity})`),
      BODY_ABOVE_FIELD_MOVE_REMEDY,
    );
  }
  // The SUBSUMPTION family (MOTIR-2903) — and this surface is the one whose
  // `advisories: []` is the observation the family exists to invert. MOTIR-2757
  // was `valid: true` with an empty array while its whole deliverable sat merged
  // on `main`.
  // ⚠️ THE TWO ARMS ARE RENDERED SEPARATELY (MOTIR-3230), because they carry
  // OPPOSITE instructions and this block is the only place most readers meet either.
  // One list would have to print `merged null` for an open pull request, and a reader
  // told a card's work "may already be in the repository" about a pull request nobody
  // has merged takes exactly the wrong action.
  const mergedHits = subsumed.filter((a) => a.state === 'merged');
  const inFlightHits = subsumed.filter((a) => a.state === 'open');
  if (mergedHits.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards name a file that a LATER merge already changed, so ` +
        'their deliverable may already be in the repository:',
      ...mergedHits.map(
        (a) =>
          `  ${a.item} names ${a.path}, changed by ${a.pullRequest} (merged ${a.mergedAt}` +
          `${a.pullRequestTitle ? ` — "${a.pullRequestTitle}"` : ''})`,
      ),
      "Read that diff against the card's acceptance criteria. If it delivers them, close the " +
        'card with the merge as the evidence rather than letting it be claimed and rebuilt. Two ' +
        'cards touching one file in sequence is the ordinary case and is why this never gates; a ' +
        'boundary-contract card that shares paths with its sibling by design opts out by saying ' +
        'so in its body (isSubsumptionCheckExempt).',
    );
  }
  if (inFlightHits.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards name a file an OPEN pull request is changing right ` +
        'now — somebody is already working here:',
      ...inFlightHits.map(
        (a) =>
          `  ${a.item} names ${a.path}, being changed by ${a.pullRequest}` +
          `${a.pullRequestTitle ? ` — "${a.pullRequestTitle}"` : ''} (OPEN, not merged)`,
      ),
      'Go and read that pull request before filing a second card against the path, and before ' +
        'cutting a branch off the default branch to fix it yourself. Two fixes for one defect ' +
        'are each green alone and CANCEL when both merge — a red trunk and a third card. Same ' +
        'family as the merged advisory and the same opt-out applies; what differs is the ' +
        'remedy, because nothing has landed yet and the cheap move is a conversation.',
    );
  }
  // The CONTAINER-COVERAGE family (MOTIR-5362) — the one advisory about a
  // container's relationship to its CHILDREN rather than about what a card says
  // or names. MOTIR-4882 was `valid: true` with three of its seven criteria owned
  // by no child, because its only code child was sealed against a different card.
  if (uncovered.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these containers have an acceptance criterion that NO child ` +
        "owns — no direct child's title carries its distinguishing words — and at least one " +
        'child was created BEFORE the container, so its criteria were written for a different parent:',
      ...uncovered.map(
        (a) =>
          `  ${a.item} criterion ${a.criterionIndex} has no owning child ` +
          `(adopted: ${a.adoptedChildren.join(', ')}) (${a.severity})`,
      ),
      'Widen the adopted work item on the record, or file the sibling that covers the difference ' +
        "— never trim the container's criterion to fit what the children happen to do. A green " +
        "subtree is evidence about the children, not about the container's own criteria. Noun " +
        'overlap is not delivery: a child whose BODY delivers the criterion under a title that does ' +
        'not name it is reported here too, and a criterion over every child ("Each story …") never is.',
    );
  }
  // The TITLE-COVERAGE family (MOTIR-8647) — the container's body against its own
  // TITLE. Everything under a container is laid against the body, so a body that
  // silently drops a part of the title narrows the whole subtree unmarked.
  if (unnamedTitles.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these containers have a title word their body never mentions, ` +
        'so the work laid under them is laid against a narrower scope than the title promises:',
      ...unnamedTitles.map(
        (a) => `  ${a.item} body never mentions: ${a.words.join(', ')} (${a.severity})`,
      ),
      'Restore the part in the body, or state it as excluded with the work item that owns it — ' +
        'never trim the title to fit the body. A part the body delivers under another word is ' +
        'reported here too.',
    );
  }
  // The PATH-REFERENCE family (MOTIR-5424) — gate 4 read on a PATH rather than a
  // key. MOTIR-5231 cited a mock its design sibling was creating, with no edge,
  // and every key-based check on this surface was silent about it.
  if (pathReferences.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards have an acceptance criterion naming a FILE that ` +
        'does not exist yet on the default branch, and ANOTHER open card names the same file ' +
        'with no blocked_by between the two — one of them creates it and the other cites it:',
      ...pathReferences.map(
        (a) =>
          `  ${a.item} criterion ${a.criterionIndex} names ${a.path} (not yet in ${a.repo}), ` +
          `also named by ${a.referenced} (${a.referencedStatus}) (${a.severity})`,
      ),
      'Wire blocked_by from the card that CITES the file to the card that CREATES it. Where the ' +
        'repository checks that a cited path resolves, the missing edge is a red check, not a ' +
        'stale reference. A card naming only the file it alone will create is never reported, ' +
        'and neither is a file whose top-level directory is absent from the repository too — ' +
        "that is another repository's file, not a forward reference.",
    );
  }
  return lines;
}

/**
 * The UNCOVERED CROSS-PARENT lines (MOTIR-6370) — shared wording for both
 * validators' text blocks. Empty when there are none.
 */
/**
 * The MISLABELLED-LINK advisories (MOTIR-9007), one block per link. Exported for
 * `validate_plan`, which reports the same finding over a plan's proposed bodies.
 * `unaffected` is the caller's "not a blocker" clause — the two verdicts phrase it
 * differently.
 */
export function mislabelledLinkLines(
  advisories: readonly WorkItemProseMislabelledLinkAdvisoryDto[],
  unaffected: string,
): string[] {
  return advisories.flatMap((a) => [
    '',
    a.targetKey === null
      ? `Advisory (${unaffected}): ${a.item} links "${a.label}" to motir:${a.targetId} in its ${a.field}, which opens NO work item. Fix the id — resolve the key you meant with get_work_item.`
      : `Advisory (${unaffected}): ${a.item} links "${a.label}" to motir:${a.targetId} in its ${a.field}, which is ${a.targetKey}. The label and the card disagree — fix the id or the label.`,
  ]);
}

export function invalidEdgeLines(
  invalidEdges: ReadonlyArray<{
    item: string;
    blockedBy: string;
    itemParent: string;
    blockerParent: string;
  }>,
): string[] {
  if (invalidEdges.length === 0) return [];
  return [
    '',
    `${invalidEdges.length} cross-parent edge(s) are not carried by their parents — a ` +
      'blocked_by between items under DIFFERENT parents is valid only when the parents carry ' +
      'the same edge:',
    ...invalidEdges.map(
      (e) =>
        `  ${e.item} is blocked by ${e.blockedBy}, but ${e.itemParent} is not blocked_by ` +
        `${e.blockerParent}`,
    ),
    'Wire each missing parent edge (and ask the same of it one level up), or drop the ' +
      'dependency if it is not real.',
  ];
}

/**
 * The CROSS-LEVEL lines (MOTIR-6509) — shared wording for both validators' text
 * blocks. Empty when there are none. The link door WRITES such an edge, so this
 * is the one place a person or an agent is told about it.
 */
export function crossLevelEdgeLines(
  crossLevelEdges: ReadonlyArray<{
    item: string;
    blockedBy: string;
    itemDepth: number;
    blockedByDepth: number;
  }>,
): string[] {
  if (crossLevelEdges.length === 0) return [];
  return [
    '',
    `${crossLevelEdges.length} edge(s) are blocked elsewhere — a blocked_by joining two ` +
      'different LEVELS (two depths below their nearest common ancestor, or an epic and a ' +
      'non-epic):',
    ...crossLevelEdges.map(
      (e) =>
        `  ${e.item} (depth ${e.itemDepth}) is blocked by ${e.blockedBy} ` +
        `(depth ${e.blockedByDepth})`,
    ),
    'The edge still holds the item out of the ready set. Re-wire it to the same-level item ' +
      'really waited on (it may sit under another parent), or between the two containers ' +
      'when the whole of one is needed.',
  ];
}

/**
 * The SECTION-finding lines (MOTIR-9032) — shared wording for both validators.
 * The body parsed against the section registry, a required section named when it
 * is missing. ADVISORY: stated as a count in a valid verdict, so a reader who
 * sees VALID is told in the same breath that the findings did not change it.
 * Empty when there are none.
 */
export function sectionFindingLines(
  findings: ReadonlyArray<{
    item: string;
    kind: string;
    type: string | null;
    state: 'unstructured' | 'incomplete';
    missing: string[];
    invalid: { section: string; message: string }[];
    otherHeadings: string[];
    signals: string[];
  }>,
  verdict: 'valid' | 'invalid',
): string[] {
  if (findings.length === 0) return [];
  return [
    '',
    `Section findings (${findings.length}, advisory — they do NOT change ${
      verdict === 'valid' ? 'VALID' : 'the verdict'
    }): the body parsed against the sections its kind and type expect:`,
    ...findings.map((f) => {
      const parts: string[] = [];
      if (f.missing.length > 0) parts.push(`missing ${f.missing.join(', ')}`);
      if (f.invalid.length > 0) {
        parts.push(`invalid ${f.invalid.map((i) => `${i.section} — ${i.message}`).join(', ')}`);
      }
      if (f.otherHeadings.length > 0) parts.push(`other headings ${f.otherHeadings.join(', ')}`);
      if (f.signals.length > 0) parts.push(`signals ${f.signals.join(', ')}`);
      return `  ${f.item} (${f.kind}/${f.type ?? 'untyped'}, ${f.state}): ${parts.join('; ')}`;
    }),
    'Re-write the card with `sections` (see `get_section_sets`) so each section is named, or add the missing heading to the body.',
  ];
}

/**
 * The SOFT-block lines (MOTIR-6368) — an ancestor's open blocker, which reaches
 * the target only through the readiness cascade. Phrased as information, never a
 * failure: soft blocks do not change `valid`.
 */
function softBlockLines(result: WorkItemValidityDto): string[] {
  if (result.softBlocks.length === 0) return [];
  return [
    `Soft blocks (${result.softBlocks.length}, do NOT affect validity) — an ancestor is blocked, ` +
      'so this work waits in the readiness cascade; `--allow-soft-block` runs it anyway:',
    ...result.softBlocks.map(
      (s) =>
        `  ${s.via.key} "${s.via.title}" is blocked by ${s.blockedBy.key} ` +
        `"${s.blockedBy.title}" (${s.blockerStatus})`,
    ),
  ];
}

/** Human-readable summary for the dual-content text block.
 *
 * `planId` is present ⟺ the verdict was computed over the PROJECTION, and the
 * text says so: the same `{ key, valid, blockers, invalidEdges, crossLevelEdges, advisories, softBlocks }` shape means two
 * different things depending on which tree it was computed over, and a reader
 * watching the session has only this block to tell them apart. */
function summarize(result: WorkItemValidityDto, planId?: string): string {
  const over = planId
    ? ` once plan ${planId} materializes (nothing was created — approving the plan in Motir is ` +
      'still the only path from a proposal to a work item)'
    : '';
  if (result.valid) {
    return [
      `Work item ${result.key} is VALID — its whole subtree can be finished within itself${over}.`,
      ...softBlockLines(result),
      ...advisoryLines(result),
      ...sectionFindingLines(result.sectionFindings, 'valid'),
    ].join('\n');
  }
  if (result.blockers.length === 0) {
    // INVALID on the edge rules alone (MOTIR-6370 / MOTIR-6509) — finishable, but
    // a cross-parent edge its parents do not carry, or an edge across levels.
    return [
      `Work item ${result.key} is INVALID${over} — its subtree can be finished, but:`,
      ...invalidEdgeLines(result.invalidEdges),
      ...crossLevelEdgeLines(result.crossLevelEdges),
      ...softBlockLines(result),
      ...advisoryLines(result),
      ...sectionFindingLines(result.sectionFindings, 'invalid'),
    ].join('\n');
  }
  return [
    `Work item ${result.key} is INVALID${over} — ${result.blockers.length} item(s) in its ` +
      'subtree are gated by out-of-subtree, unsatisfied work:',
    ...result.blockers.map(
      (b) =>
        `  ${b.item} is blocked by ${b.blockedBy} (${b.blockerStatus}, ` +
        `${b.blockerSprintId ? `sprint ${b.blockerSprintId}` : 'backlog'})`,
    ),
    'Pull these into the subtree (or finish them), or drop the dependency.',
    ...invalidEdgeLines(result.invalidEdges),
    ...crossLevelEdgeLines(result.crossLevelEdges),
    ...softBlockLines(result),
    ...advisoryLines(result),
    ...sectionFindingLines(result.sectionFindings, 'invalid'),
  ].join('\n');
}

export async function runValidateWorkItem(
  args: ValidateWorkItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    // `conditionField` fills the default (`loose`) when omitted, and both
    // service params default too — so no `??` on either path (it would add a
    // never-taken branch).
    if (args.planId !== undefined) {
      // PROJECTED. No project lookup here: `buildProjection` resolves the
      // project FROM the plan (and asserts browse on it), and a `planItem:<id>`
      // target has no project-key prefix to derive one from anyway.
      const projected = await planValidityService.validateProjectedWorkItem(
        args.planId,
        normalizeProjectedTarget(args.key),
        ctx,
        args.condition,
      );
      return toolOk(
        summarize(projected, args.planId),
        exempt('validate_work_item', projected as unknown as Record<string, unknown>),
      );
    }
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const result = await workItemsService.validateWorkItem(
      project.id,
      identifier,
      ctx,
      args.condition,
    );
    return toolOk(
      summarize(result),
      exempt('validate_work_item', result as unknown as Record<string, unknown>),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerValidateWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    VALIDATE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Validate work-item finishability',
      description:
        'Check whether a work item (any non-leaf kind — epic / story / task / bug) is FINISHABLE: ' +
        'every not-done item in its SUBTREE (the item + all descendants) has each blocked_by ' +
        'dependency either inside the subtree (its own work) or done. A blocker inside the subtree ' +
        'never gates; only out-of-subtree work can. `condition` defaults to `loose` (a done ' +
        'dependency outside the subtree counts as satisfied); pass `tight` to require every ' +
        'dependency to be IN the subtree (a done item outside it is then reported as a blocker). ' +
        'Returns `{ key, valid, blockers: [...], invalidEdges: [...], crossLevelEdges: [...], ' +
        'advisories: [...], softBlocks: [...], sectionFindings: [...] }` — `blockers` naming each in-subtree item and the out-of-subtree, ' +
        'unsatisfied work gating it (always an item’s OWN blocked_by edge); `invalidEdges` naming ' +
        'each same-level blocked_by between items under DIFFERENT parents whose parents carry no ' +
        'matching edge (`{ item, blockedBy, itemParent, blockerParent }` — a cross-parent edge is ' +
        'valid only when the parents carry it; an end with no work-item parent is exempt); ' +
        '`crossLevelEdges` naming each blocked_by FROM a subtree member to an item on ANOTHER ' +
        'LEVEL — a different depth below their nearest common ancestor, or an epic and a ' +
        'non-epic — as `{ item, blockedBy, itemDepth, blockedByDepth, reason: ' +
        '"blocked_elsewhere", explanation }` (the link door writes such an edge and it still ' +
        'holds the item out of the ready set; the plan gate refuses a PROPOSED one). ' +
        '`valid` is true only when ALL THREE are empty. `softBlocks` is NON-GATING: each open ' +
        'blocked_by of one of the target’s ANCESTORS, as `{ via: { key, title }, blockedBy: ' +
        '{ key, title }, blockerStatus }` — a block that reaches the target only through the ' +
        'readiness cascade and that `--allow-soft-block` overrides at run time; it never changes ' +
        '`valid`. `advisories` is a ' +
        'SEPARATE, NEVER-BLOCKING channel with two families: a `reference` advisory names an ' +
        'in-subtree card whose DESCRIPTION names a not-done work item it has no blocked_by edge ' +
        "to (severity `likely-missing-edge` when the reference sits in the card's own acceptance " +
        'criteria, else `advisory`); a `shape` advisory (`kind: "shape"`) names a card that ' +
        'contradicts ITSELF — `likely-ordering-violation` when a criterion carries one of a few ' +
        'MERGE-WORDS (with the matched phrase) — a partial tell: a criterion that reads the ' +
        'deployment as EVIDENCE ("against real runs", "quoted here") carries none, so its ' +
        'absence does NOT clear the card — `likely-repo-straddle` when it names a ' +
        "path in a repo that is not the card's `targetRepo` (with the path, that repo, and " +
        '`reason: "contradiction"`, or `"unpinnable"` when the card pins no repo and its criteria ' +
        'name two or more) — both with the 1-based criterion index to cut at — ' +
        '`likely-over-gate-sizing` when a CHILDLESS coding_agent card is sized over the estimation ' +
        'gate, at 8+ story points or more than 70 estimated minutes — the points arm is the ' +
        "gate's own literal SPLIT signal, the minutes arm is a PROXY for its run ceiling, because " +
        '`estimateMinutes` sums agent time and CI time while the gate ceilings the agent run ' +
        'alone (with `threshold`, the observed `storyPoints` and `estimateMinutes`, and no ' +
        'criterion index, because the remedy is to SPLIT the card rather than cut it at a line), ' +
        'or `likely-self-blocking-design` when ' +
        'a CHILDLESS card that is not itself `type: design` or `type: test` is its OWN design blocker — one ' +
        'criterion produces a design asset and ' +
        'another builds the rendered surface that drawing decides (with BOTH 1-based indices, ' +
        '`designCriterionIndex` and `surfaceCriterionIndex`, because the remedy LIFTS the design ' +
        'criterion onto its own card rather than cutting the list at a line), or ' +
        "`body-edit-above-field-move` when the card's newest body write moved none of the fields a " +
        'body describes (`title`, `type`, `executor`, `targetRepo`/`targetRepos`, `kind`, ' +
        '`storyPoints`, `estimateMinutes`) while the write directly beneath it did (with ' +
        '`bodyEdit` and `fieldMove`, each `{ at, fields }`, and no criterion index — a prompt to ' +
        're-read the body against the move, since a body rewritten to match it leaves the same ' +
        'trail), or ' +
        "`likely-blocker-count-mismatch` when an explicit counted claim about the card's own " +
        'blocker siblings disagrees with its current blocked_by edge count (with the exact ' +
        '`claim`, `claimedCount`, and `blockerCount`), or `under-authored` when a CHILDLESS card ' +
        'has no enumerated acceptance criterion AND null `storyPoints`, `estimateMinutes`, `type` ' +
        'and `executor` (with `criteria`: `no-heading` or `no-criterion` — a pure null check, ' +
        'never a gate, because a card is routinely saved mid-authoring), or ' +
        '`likely-mislabelled-link` when a `[label](motir:<id>)` link in the description OR the ' +
        'explanation opens a different card than the key its label names, or opens no card at ' +
        'all (with the `label`, the `targetId`, the `targetKey` it really opens, `null` for none, ' +
        'and the `field` it sits in: `descriptionMd` or `explanationMd`). A `coverage` ' +
        'advisory (`kind: "coverage"`, `likely-unowned-criterion`) names a CONTAINER one of whose ' +
        "acceptance criteria no direct child's TITLE carries, reported only when a child was " +
        'created BEFORE the container (adopted) — with the `criterionIndex` and the ' +
        '`adoptedChildren`; the remedy is to widen the adopted work item on the record or file the ' +
        'sibling that covers the difference. A `title-coverage` advisory (`kind: "title-coverage"`, `likely-unnamed-title-part`) names a CONTAINER whose body never mentions one or more distinguishing words its TITLE carries — with the `words`; the remedy is to restore the part in the body or state it as excluded with its owner. A `path-reference` advisory (`kind: ' +
        '"path-reference"`, `likely-missing-path-edge`) names a card whose acceptance criterion ' +
        'names a FILE PATH that does not exist yet on the default branch of its repository (its ' +
        'top-level directory does) while ANOTHER not-done work item also names that path, with no ' +
        'blocked_by between the two or their ancestors — with the `path`, the `criterionIndex`, ' +
        'the `repo`, and the other item as `referenced` / `referencedStatus`; the remedy is to ' +
        'wire blocked_by from the citing card to the creating one. Advisories ' +
        'never affect `valid` or `blockers` — a card with advisories is still valid and ready. ' +
        '`sectionFindings` is a second advisory channel of the same kind: each not-done subtree ' +
        'card whose BODY, parsed against the section registry for its kind and type, misses a ' +
        'required section or carries one it cannot read, as `{ item, state: "unstructured" | ' +
        '"incomplete", missing, invalid, otherHeadings, signals }` — it never changes `valid`. ' +
        'A heading the registry does not define is an allowed `otherSections` entry, listed in ' +
        '`otherHeadings` beside a real finding and never a finding on its own. ' +
        'Pass `planId` to ask the SAME question over a plan you are authoring: the verdict is ' +
        'then computed over the project’s live tree ⊕ that plan’s proposals, so you can check a ' +
        'subtree you have PROPOSED before anybody reviews it. With a `planId`, `invalidEdges` ' +
        'and `crossLevelEdges` hold only the findings the PLAN introduces — an edge whose item ' +
        'or blocker, or an ancestor of either, the plan adds, re-parents, re-wires or removes; ' +
        'an old bad edge it touches nothing of is reported only without a `planId`. ' +
        TEMP_REF_HELP +
        ' Use `validate_plan` for the whole plan at once — do not loop this call per root, ' +
        'because an edge between two sibling roots is valid there and a false positive here. ' +
        'Read-only, projected or not: it creates nothing and persists nothing.',
      inputSchema,
    },
    async (args, extra) => runValidateWorkItem(args, resolveContext(extra)),
  );
}
