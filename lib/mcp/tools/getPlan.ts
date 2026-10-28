import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import type { PlanItemDto, PlanItemOpDto, PlanWithItemsDto } from '@/lib/dto/plans';
import { isTempRef, tempRefId } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { planPayload, presentMcpPlan } from '../payloads/workLoop';
import { firstLine } from '../obsolescence';
import { DEFAULT_PROPOSED_KIND } from '@/lib/plans/validateProposals';
import { parseSections, type ParsedBody } from '@/lib/workItems/sections/parse';
import type { IssueType } from '@/lib/issues/parentRules';
import type { SectionType } from '@/lib/workItems/sections/registry';
import { includeSectionsField, PARSED_SECTIONS_DESCRIPTION } from '../parsedSections';
import { GET_PLAN_STATUS_TOOL_NAME } from './expandItem';

// `get_plan` (Story 7.9 · MOTIR-1837) — the plan read that returns WHAT was
// proposed, not just how many.
//
// Why it exists: `get_plan_status` (MOTIR-1825) answers "what became of the job
// I fired?" with a `PlanOutcomeDto` — a status and an `itemCount`. That is
// enough to know a planning pass landed, and nothing at all about whether it
// landed WELL. The items themselves have shipped as a DTO since the 7.21
// substrate (`PlanWithItemsDto`), but the only way to reach them was
// `GET /api/plans/[id]` — cookie-authed, so unreachable from an MCP client. A
// headless caller could therefore print a count and a URL, and then had to send
// its user to a browser at exactly the moment they needed to judge the output.
//
// This is a TRANSPORT, not a second read path: `plansService.getPlan` is the
// same method the cookie route's review model reads through, and it already
// applies the workspace scoping + `canBrowse` gate, so the 404-not-403
// cross-tenant contract carries here unchanged. No new DTO, no re-mapping, no
// pagination invented at this layer (the service exposes none).
//
// The same PROPOSAL GATE its siblings carry applies, and for a sharper reason:
// this tool hands back titles, kinds and sizing that read exactly like work
// items. They are not. `plansService.approvePlan` is the only path from a
// proposal to a `work_item` row, and an `add`'s `workItemId` stays `null` until
// then.
//
// ⚠️ AMENDED 2026-08-19 (MOTIR-3021). This used to read "a human decision made
// in Motir", and the ONLY-PATH half is still exactly true — approve remains the
// single proposal→row write. What is no longer true is that it happens only in
// the app: `POST /api/v1/plans/{planId}/approval` is a bounded public entrance
// an operator's `motir auto --auto-approve-replan` drives
// (`docs/decisions/run-findings-protocol.md` Q2). It is deliberately NOT an MCP
// tool — MCP is the AGENT's surface, and an agent must never approve its own
// re-plan — so nothing about THIS tool's reach changed.

export const GET_PLAN_TOOL_NAME = 'get_plan';

const getPlanInputSchema = {
  planId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The plan id — as returned by an `expand_item` submit, by `get_plan_status`, or shown ' +
        'on the plan in Motir.',
    ),
  includeSections: includeSectionsField,
};

/** The op markers the review surface uses: add / modify / remove. */
const OP_MARKER: Record<PlanItemOpDto, string> = { add: '+', modify: '~', remove: '-' };

/** ` (3 pts · 40m · high)` — the leaf sizing and its DIFFICULTY (MOTIR-6136),
 *  when the proposal carries any. The difficulty rides beside the size because
 *  it is the other half of how a reviewer judges a leaf: how big, how hard. */
function sizing(
  storyPoints: number | null | undefined,
  estimateMinutes: number | null | undefined,
  difficulty?: string | null,
) {
  const parts: string[] = [];
  if (storyPoints != null) parts.push(`${storyPoints} pts`);
  if (estimateMinutes != null) parts.push(`${estimateMinutes}m`);
  if (difficulty != null) parts.push(difficulty);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}

/** ` · repo: <name>` — WHICH REPO the proposal pins the item to (MOTIR-1884).
 *  Omitted when unpinned, so a single-repo project's plan reads exactly as it
 *  did before pins existed. */
function repoPin(targetRepo: string | null | undefined): string {
  return targetRepo ? ` · repo: ${targetRepo}` : '';
}

/**
 * ` · N steps` — how many to-do rows this `add` proposes (MOTIR-4619).
 *
 * A COUNT and not the rows: this line is one proposal in a list a reviewer
 * scans, and a four-step card printed in full would push the next proposal off
 * the screen. The steps themselves ride `structuredContent.proposedFields.todos`
 * verbatim, so a client that wants them already has them without a second call.
 */
function steps(todos: readonly unknown[] | null | undefined): string {
  const n = todos?.length ?? 0;
  return n > 0 ? ` · ${n} step${n === 1 ? '' : 's'}` : '';
}

/** ` · blocked_by: <ref> (<reason>), <ref>` — the proposed dependency edges,
 *  verbatim (a real work-item id or an intra-plan `planItem:` temp-ref), each with
 *  the reason it was drawn for when it carries one (MOTIR-9827). */
function blockers(refs: readonly string[], reasons?: Readonly<Record<string, string>>): string {
  const edge = (ref: string) => (reasons?.[ref] ? `${ref} (${reasons[ref]})` : ref);
  return refs.length > 0 ? ` · blocked_by: ${refs.map(edge).join(', ')}` : '';
}

/** ` · reasons: <ref> (<reason>)` — the reasons a `modify`'s added edges carry
 *  (MOTIR-9827); the refs themselves are listed by the patch key above. */
function modifyEdgeReasons(item: PlanItemDto): string {
  const refs = (item.patch?.blockedByAdd ?? []).filter((ref) => item.edgeReasons?.[ref]);
  return refs.length > 0
    ? ` · blockedByAdd reasons: ${refs.map((ref) => `${ref} (${item.edgeReasons[ref]})`).join(', ')}`
    : '';
}

/**
 * Where a proposal sits in the COMMITTED tree, and what its target is CALLED —
 * the half of the rendering that cannot be read off a `PlanItemDto` (bug
 * MOTIR-3191). Supplied by the caller from `planReviewService.getPlanReview`,
 * keyed by `planItemId`; absent for a client that has no tree to resolve against,
 * and the rendering then degrades to the flat list it was.
 */
export interface ProposalPlacement {
  /** The target's own key (`MOTIR-3181`), when the proposal has a live target. */
  identifier: string | null;
  /** The committed parent's id — the grouping key. */
  parentNodeId: string | null;
  /** The committed ancestor path down to that parent, ROOT FIRST. */
  parentTrail: { identifier: string; title: string }[];
  /**
   * The folder the proposal will sit in (MOTIR-5415) — the second grouping key,
   * for a proposal whose placement is a folder rather than a work item. Absent
   * on a placement built before folders existed, which renders as it did.
   */
  folderId?: string | null;
  /** That folder's names, ROOT FIRST; null when it no longer exists. */
  folderPath?: string[] | null;
  /** The folder was deleted after the plan was written. */
  folderMissing?: boolean;
}

export type PlacementByPlanItemId = ReadonlyMap<string, ProposalPlacement>;

/**
 * The KEYS and current marks a proposed MARK is rendered with (Story MOTIR-6577 ·
 * MOTIR-6631) — `planReviewService.resolveProposalMarkRefs`, keyed by work-item
 * id. Absent for a caller that could not read them; a ref it does not name is
 * then printed verbatim, exactly as `blocked_by` prints its refs.
 */
export interface ProposalMarkRefs {
  keyById: ReadonlyMap<string, string>;
  markById: ReadonlyMap<string, string | null>;
  /** The live step count of each `modify` target whose patch REPLACES its list
   *  (MOTIR-8668) — how many rows it has and how many are ticked. Absent from a
   *  caller that did not read it; the line then prints `replaces ?`. */
  todoCountById?: ReadonlyMap<string, { total: number; done: number }>;
}

/** A ref as the reader's word for it: its KEY when one resolved, else verbatim. */
function refLabel(ref: string, marks?: ProposalMarkRefs): string {
  return marks?.keyById.get(ref) ?? ref;
}

/** ` · supersedes K1, K2` — the older cards an `add` replaces. */
function addSupersedes(refs: readonly string[] | undefined, marks?: ProposalMarkRefs): string {
  return refs && refs.length > 0
    ? ` · supersedes ${refs.map((r) => refLabel(r, marks)).join(', ')}`
    : '';
}

/**
 * A `modify`'s MARK, as the reviewer reads it: `mark: none → outdated` (the old
 * side from the target's live row, `?` when it could not be read), the note's
 * first line, and the supersedes deltas by key — `supersedes +K1 −K2` for the
 * edges the target gains or loses as the NEWER card, `superseded by +K3` for the
 * ones where it is the OLD card. Empty when the patch carries none of the six.
 */
function modifyMark(item: PlanItemDto, marks?: ProposalMarkRefs): string {
  const patch = item.patch ?? {};
  const parts: string[] = [];
  if (patch.obsolescence !== undefined) {
    const known = item.workItemId != null && marks?.markById.has(item.workItemId);
    const from = known ? (marks!.markById.get(item.workItemId!) ?? 'none') : '?';
    parts.push(`mark: ${from} → ${patch.obsolescence ?? 'none'}`);
  }
  if (patch.obsolescenceNoteMd !== undefined) {
    parts.push(`note: ${firstLine(patch.obsolescenceNoteMd) ?? '(cleared)'}`);
  }
  const delta = (added?: string[], removed?: string[]) =>
    [
      ...(added ?? []).map((r) => `+${refLabel(r, marks)}`),
      ...(removed ?? []).map((r) => `−${refLabel(r, marks)}`),
    ].join(' ');
  const supersedes = delta(patch.supersedesAdd, patch.supersedesRemove);
  if (supersedes) parts.push(`supersedes ${supersedes}`);
  const supersededBy = delta(patch.supersededByAdd, patch.supersededByRemove);
  if (supersededBy) parts.push(`superseded by ${supersededBy}`);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

/**
 * ` · todos: N steps (replaces M, K ticked)` — a `modify`'s REPLACEMENT step
 * list (MOTIR-8668 · AMENDMENT 27). The ticked count is the point: approve
 * deletes those rows, and they are a person's progress, so the reviewer reads
 * the cost on the same line as the change. `cleared` for `[]` / `null`; `?` for
 * the old side when the live list could not be read. Empty when the patch
 * leaves the list alone.
 */
function modifySteps(item: PlanItemDto, marks?: ProposalMarkRefs): string {
  const todos = item.patch?.todos;
  if (todos === undefined) return '';
  const n = todos?.length ?? 0;
  const count = item.workItemId ? marks?.todoCountById?.get(item.workItemId) : undefined;
  const known = item.workItemId != null && marks?.todoCountById !== undefined;
  const replaces = !known
    ? 'replaces ?'
    : count && count.total > 0
      ? `replaces ${count.total}${count.done > 0 ? `, ${count.done} ticked` : ''}`
      : 'replaces none';
  const what = n > 0 ? `${n} step${n === 1 ? '' : 's'}` : 'cleared';
  return ` · todos: ${what} (${replaces})`;
}

/** ` · sections missing: a, b` / ` · sections: complete` — only when the sections
 *  view was asked for (MOTIR-9033), so an unasked line is unchanged. */
function sectionsSuffix(parsed: ParsedBody | undefined): string {
  if (!parsed) return '';
  return parsed.missing.length > 0
    ? ` · sections missing: ${parsed.missing.join(', ')}`
    : ' · sections: complete';
}

/** One proposal as a single line — the op, what it targets, and its sizing. */
function describeItem(
  item: PlanItemDto,
  placement?: ProposalPlacement,
  marks?: ProposalMarkRefs,
  sections?: ReadonlyMap<string, ParsedBody>,
): string {
  const marker = OP_MARKER[item.op];
  if (item.op === 'add') {
    const fields = item.proposedFields;
    const kind = fields?.kind ?? 'task';
    const type = fields?.type ? `/${fields.type}` : '';
    const title = fields?.title ?? '(untitled)';
    return (
      `${marker} [${kind}${type}] ${title}` +
      sizing(fields?.storyPoints, fields?.estimateMinutes, fields?.difficulty) +
      repoPin(fields?.targetRepo) +
      steps(fields?.todos) +
      blockers(item.blockedByRefs, item.edgeReasons) +
      addSupersedes(item.supersedesRefs, marks) +
      sectionsSuffix(sections?.get(item.id))
    );
  }
  // The target by its KEY when the tree could be read (MOTIR-3191). `MOTIR-3181`
  // is what the reviewer knows the card as; the cuid this used to print is an
  // identifier for the database and for nobody reading a plan.
  const target = placement?.identifier ?? item.workItemId ?? '(no target)';
  if (item.op === 'remove') return `${marker} remove ${target}`;
  const patch = item.patch ?? {};
  const changed = Object.keys(patch).filter(
    (key) => patch[key as keyof typeof patch] !== undefined,
  );
  return (
    `${marker} modify ${target}` +
    (changed.length > 0 ? ` — ${changed.join(', ')}` : '') +
    modifySteps(item, marks) +
    modifyMark(item, marks) +
    modifyEdgeReasons(item) +
    blockers(item.blockedByRefs, item.edgeReasons)
  );
}

/** `under MOTIR-2200 ▸ MOTIR-3154 — A DECIDED plan's cards vanish:` — the live
 *  branch a group of proposals hangs off, named the way the canvas breadcrumb
 *  names it. */
/** The heading a folder-placed group is printed under (MOTIR-5415). A deleted
 *  folder has no name left, so it is named by id and marked. */
function folderHeading(placement: ProposalPlacement): string {
  if (placement.folderMissing || !placement.folderPath) {
    return `Folder: (deleted — folder:${placement.folderId}) — approve will refuse this plan:`;
  }
  return `Folder: ${placement.folderPath.join(' ▸ ')}:`;
}

function groupHeading(trail: { identifier: string; title: string }[]): string {
  const chain = trail.map((c) => c.identifier).join(' ▸ ');
  const parent = trail.at(-1)!;
  return `under ${chain} — ${parent.title}:`;
}

/**
 * The proposals as an indented tree, so a terminal client that ignores
 * `structuredContent` can still SEE the shape that was proposed.
 *
 * Nesting inside the PLAN follows `parentRef`'s intra-plan temp-ref form
 * (`planItem:<id>`) — an `add` under another `add` in this same plan.
 *
 * Everything else hangs off a branch of the LIVE tree, and is grouped under a
 * heading that names it (bug MOTIR-3191). That covers a `parentRef` pointing at a
 * real work item, and — the case this fixes — a `modify` / `remove`, which
 * carries no `parentRef` at all and inherits its target's position. Un-indented,
 * the two were indistinguishable from an `add` at the PROJECT ROOT, which the
 * plan rules reserve for epics: a plan of two amendments read as two new
 * root-level cards, and was correctly declined on that reading.
 *
 * With no `placements` (a caller that could not resolve the tree) this degrades
 * to exactly the flat rendering it had — the same contract every other
 * tree-resolution failure on this surface takes.
 */
function renderProposals(
  items: PlanItemDto[],
  placements?: PlacementByPlanItemId,
  marks?: ProposalMarkRefs,
  sections?: ReadonlyMap<string, ParsedBody>,
): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const childrenOf = new Map<string, PlanItemDto[]>();
  const roots: PlanItemDto[] = [];
  for (const item of items) {
    const parentId = item.parentRef && isTempRef(item.parentRef) ? tempRefId(item.parentRef) : null;
    if (parentId != null && byId.has(parentId)) {
      const siblings = childrenOf.get(parentId);
      if (siblings) siblings.push(item);
      else childrenOf.set(parentId, [item]);
    } else {
      roots.push(item);
    }
  }

  const lines: string[] = [];
  const rendered = new Set<string>();
  const walk = (item: PlanItemDto, depth: number): void => {
    // Defensive: a temp-ref CYCLE has no root, and would otherwise recurse until
    // the stack blows. `addProposals` rejects one at the boundary, so this is a
    // backstop for rows that reached the table some other way — never a normal
    // path.
    if (rendered.has(item.id)) return;
    rendered.add(item.id);
    lines.push(
      `${'  '.repeat(depth + 1)}${describeItem(item, placements?.get(item.id), marks, sections)}`,
    );
    for (const child of childrenOf.get(item.id) ?? []) walk(child, depth + 1);
  };

  // The live-tree branches, in the order they first appear, so a plan's own
  // ordering survives the grouping.
  const groups = new Map<string, { heading: string; items: PlanItemDto[] }>();
  const ungrouped: PlanItemDto[] = [];
  for (const root of roots) {
    const placement = placements?.get(root.id);
    const trail = placement?.parentTrail ?? [];
    // A FOLDER-placed root groups under its folder path (MOTIR-5415), beside the
    // committed-parent groups — a folder is not a parent, so it has its own key.
    if (placement?.folderId && !placement.parentNodeId) {
      const key = `folder:${placement.folderId}`;
      const group = groups.get(key);
      if (group) group.items.push(root);
      else groups.set(key, { heading: folderHeading(placement), items: [root] });
      continue;
    }
    if (!placement?.parentNodeId || trail.length === 0) {
      ungrouped.push(root);
      continue;
    }
    const group = groups.get(placement.parentNodeId);
    if (group) group.items.push(root);
    else groups.set(placement.parentNodeId, { heading: groupHeading(trail), items: [root] });
  }

  for (const root of ungrouped) walk(root, 0);
  for (const { heading, items: grouped } of groups.values()) {
    lines.push(`  ${heading}`);
    for (const item of grouped) walk(item, 1);
  }
  // Anything a cycle kept out of the root set is still the caller's data — print
  // it rather than silently dropping proposals from a list the client trusts.
  for (const item of items) walk(item, 0);
  return lines;
}

/** The human-readable block: the plan's own line, then its proposal tree.
 *  `placements` (MOTIR-3191) is what lets a proposal about an EXISTING card be
 *  drawn where that card lives; without it the tree renders flat, as it did. */
export function summarizePlan(
  plan: PlanWithItemsDto,
  placements?: PlacementByPlanItemId,
  marks?: ProposalMarkRefs,
  sections?: ReadonlyMap<string, ParsedBody>,
): string {
  const lines = [
    `Plan ${plan.id} — ${plan.status}, ${plan.itemCount} proposal(s).`,
    `Project ${plan.projectId} · origin ${plan.origin}` +
      (plan.sourceJobId ? ` · job ${plan.sourceJobId}` : ''),
  ];
  if (plan.title) lines.push(`Title: ${plan.title}`);
  if (plan.summary) lines.push(`Summary: ${plan.summary}`);

  lines.push('');
  if (plan.items.length === 0) {
    lines.push(
      plan.status === 'generating'
        ? 'No proposals have arrived yet — the planner is still generating this plan.'
        : 'This plan bundles no proposals.',
    );
  } else {
    lines.push(
      'Proposals (indented under their proposed parent):',
      ...renderProposals(plan.items, placements, marks, sections),
    );
  }

  lines.push(
    '',
    plan.status === 'approved'
      ? 'This plan was approved — its proposals were materialized into work items.'
      : 'These are PROPOSALS, not work items. Approving the plan in Motir is the only thing ' +
          "that creates one, and an `add`'s workItemId stays null until then.",
  );

  // ⚠️ `stale` NEEDS SAYING, because the bare status word above does not carry
  // it (MOTIR-3578). An agent reading `stale` off line 1 has no way to know the
  // plan is unapprovable-but-live rather than a variant of `declined`, and the
  // wrong reading costs it the same wasted repair MOTIR-3560 was filed about:
  // authoring a whole replacement plan for one that may simply come back.
  if (plan.status === 'stale') {
    lines.push(
      '',
      'STALE: this plan reached a reviewer and can no longer be approved, because work it ' +
        'proposes to change has since been finished. It is NOT decided and NOT declined — the ' +
        'plan is live, and if the drift reverses (a target leaves its terminal status) it ' +
        'returns to `planned` on its own. Do NOT author a replacement plan on seeing this; ' +
        'the reviewer decides whether to wait or decline.',
    );
  }
  return lines.join('\n');
}

/**
 * Where each proposal sits in the live tree — the SAME resolution the plan-review
 * canvas draws from, so the two surfaces cannot disagree about what a plan
 * proposes (bug MOTIR-3191). Read separately because `PlanWithItemsDto` carries
 * refs and ids, and placement is a question about the WORK ITEMS those ids name.
 *
 * BEST-EFFORT on purpose: this enriches a rendering that already worked without
 * it, and the tool's job — hand back what was proposed — must not start failing
 * because a tree read did. A failure degrades to the flat list.
 */
async function resolvePlacements(
  planId: string,
  ctx: ServiceContext,
): Promise<PlacementByPlanItemId | undefined> {
  try {
    const review = await planReviewService.getPlanReview(planId, ctx);
    return new Map(
      review.items.map((item) => [
        item.planItemId,
        {
          identifier: item.identifier,
          parentNodeId: item.parentNodeId,
          parentTrail: item.parentTrail.map((c) => ({
            identifier: c.identifier,
            title: c.title,
          })),
          folderId: item.folderId,
          folderPath: item.folderPath,
          folderMissing: item.folderMissing,
        },
      ]),
    );
  } catch {
    return undefined;
  }
}

/**
 * The keys and live marks a proposed MARK renders with (MOTIR-6631) —
 * BEST-EFFORT for the reason {@link resolvePlacements} is: it enriches a line
 * that already renders without it, so a failed read degrades to verbatim refs
 * and a `?` old mark rather than failing the tool.
 */
async function resolveMarks(
  plan: PlanWithItemsDto,
  ctx: ServiceContext,
): Promise<ProposalMarkRefs | undefined> {
  try {
    return await planReviewService.resolveProposalMarkRefs(plan, ctx);
  } catch {
    return undefined;
  }
}

/** The adapter: read the plan through the service, summarize, return. */
export async function runGetPlan(
  args: { planId: string; includeSections?: boolean },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  // The READER's door (MOTIR-6330): a plan outside the Plans room's scope for
  // this caller — role AND token grant — is not-found, like an unknown id.
  const plan = await plansService.getPlanForReader(args.planId, ctx);
  const placements = await resolvePlacements(args.planId, ctx);
  // The folders the proposals NAME (MOTIR-5415), for the structured payload —
  // the same reading `/api/v1` presents beside `parentRef`.
  const folders = await planReviewService.resolveProposalFolders(plan, ctx);
  const marks = await resolveMarks(plan, ctx);
  // The sections view (MOTIR-9033): every `add`'s proposed body parsed with the
  // kind the plan doors default an unsaid kind to. `modify` / `remove` carry a
  // patch on a card whose kind and type may sit outside it, so they are not parsed.
  // Absent unless asked for; `items` are never touched.
  const sections = args.includeSections
    ? new Map<string, ParsedBody>(
        plan.items
          .filter((item) => item.op === 'add')
          .map((item) => {
            const fields = item.proposedFields;
            return [
              item.id,
              parseSections(
                fields?.descriptionMd,
                (fields?.kind ?? DEFAULT_PROPOSED_KIND) as IssueType,
                (fields?.type ?? null) as SectionType,
              ),
            ] as const;
          }),
      )
    : undefined;
  return toolOk(
    summarizePlan(plan, placements, marks, sections),
    derived(planPayload, {
      ...presentMcpPlan(plan, folders),
      ...(sections ? { parsedSections: Object.fromEntries(sections) } : {}),
    }),
  );
}

export function registerGetPlan(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_PLAN_TOOL_NAME,
    {
      title: 'Read plan proposals',
      description:
        'Read a plan WITH the proposals it bundles — what an AI planning pass actually ' +
        'proposed, not just how many items it produced. Returns the plan plus `items[]`: each ' +
        "proposal's `op` (add / modify / remove), the `proposedFields` of an `add` (title, " +
        'kind, type, priority, executor, storyPoints, estimateMinutes, difficulty — how hard ' +
        'the leaf is to reason about, rendered beside its size as `(3 pts · 40m · high)` — description, ' +
        "targetRepo — which repo of the project's set the item ships in — and `todos`, the " +
        'card’s ORDERED STEPS, which the one-line render summarises as `· N steps` and ' +
        '`structuredContent` carries in full), the ' +
        '`patch` of a `modify`, and the `parentRef` / `blockedByRefs` that let you rebuild the ' +
        'proposed tree and its dependency edges. A proposed OBSOLESCENCE MARK is shown too: a ' +
        '`modify` line prints `mark: <current> → <proposed>`, the note’s first line, and its ' +
        'supersedes edges by key — `supersedes +K1 −K2` (the target replaces / stops replacing ' +
        'them) and `superseded by +K3` (K3 replaces the target) — and an `add` line prints ' +
        '`supersedes K1, K2` from its `supersedesRefs`; `structuredContent` carries the patch ' +
        'keys and `supersedesRefs` in full. A `modify` whose patch REPLACES the target’s steps ' +
        'prints `todos: N steps (replaces M, K ticked)` — approve deletes the old rows, ticked ' +
        'ones included. ' +
        `Reach for \`${GET_PLAN_STATUS_TOOL_NAME}\` ` +
        'instead when you only need the status of a submitted job (and whether that job died); ' +
        'reach for this one to SHOW or judge the content. A plan still generating returns the ' +
        'proposals that have arrived so far. ' +
        'IMPORTANT: these are PROPOSALS, NOT work items. Nothing here exists in the tree: ' +
        'approving the plan in Motir is the only path from a proposal to a work item, and an ' +
        "`add`'s `workItemId` stays null until then. Do not report proposed items as created. " +
        'A pure read.' +
        PARSED_SECTIONS_DESCRIPTION.replace(
          'to also receive `parsedSections` — the body parsed',
          'to also receive `parsedSections` — a map keyed by plan item id, one entry per `add`, ' +
            'each proposal’s body parsed',
        ),
      inputSchema: getPlanInputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetPlan(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
