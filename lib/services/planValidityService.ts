import { gatingItemSatisfied } from '@/lib/workItems/validity';
import { touchesBodyOrWatchedField } from '@/lib/workItems/bodyAboveFieldMove';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { TEMP_REF_PREFIX, plansService } from '@/lib/services/plansService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { NoActiveSprintError } from '@/lib/sprints/errors';
// The PROJECTION itself moved to its own service in MOTIR-3096, because the
// projected READS are a second consumer of it. The rules are unchanged; what
// changed is that they are no longer private to this file.
import {
  buildProjection,
  isDone,
  resolveProjectedRoot,
  type Projection,
  type ProjectedNode,
} from '@/lib/services/planProjectionService';
import {
  buildProseVsGraphAdvisories,
  type ProseAdvisoryLocalRef,
} from '@/lib/services/proseGraphAdvisoryService';
import {
  NOT_YET_FILED,
  containerCoverageFinding,
  unnamedTitleWords,
  type CoverageChild,
} from '@/lib/workItems/containerCoverage';
import { acceptanceCriteriaTexts } from '@/lib/workItems/proseVsGraph';
import { uncoveredCrossParentEdges, type CoverageEdge } from '@/lib/workItems/crossParentCoverage';
import { crossLevelEdgeFindings } from '@/lib/workItems/edgeLevel';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  CrossLevelEdgeDto,
  InvalidEdgeDto,
  WorkItemCoverageAdvisoryDto,
  WorkItemTitleCoverageAdvisoryDto,
  WorkItemProseAdvisoryDto,
  WorkItemProseShapeAdvisoryDto,
  WorkItemSoftBlockDto,
  WorkItemValidityDto,
} from '@/lib/dto/workItems';
import { isMislabelledLinkAdvisory } from '@/lib/dto/workItems';
import type { PlanValidityDto, PlanWithItemsDto, ProposalRescopeWarningDto } from '@/lib/dto/plans';
import { proposalRescopeWarningsService } from '@/lib/services/proposalRescopeWarningsService';
import type { SectionFindingDto } from '@/lib/dto/workItems';
import { sectionFindingsFor } from '@/lib/workItems/sections/validity';
import type { SprintBlockerDto, SprintValidityDto } from '@/lib/dto/sprints';
import { type ValidityCondition, DEFAULT_VALIDITY_CONDITION } from '@/lib/dto/sprints';

// ── Pre-commit plan validation (Story 7.28 · Subtask 7.28.1 / MOTIR-1386) ──────
//
// The PlanItem-stage analogue of the shipped `validate_work_item` /
// `validate_sprint` MCP tools (MOTIR-1374/1375). Those answer "is this finishable"
// over the LIVE `work_item` tree; this answers the SAME question over the
// PROJECTED tree — the live tree ⊕ a Plan's `PlanItem` delta — so the AI planner
// can self-correct BEFORE it materializes a plan, and the `motir run` loop never
// inherits an un-finishable sprint.
//
// It REUSES, never re-implements, the finishability PREDICATE
// (`gatingItemSatisfied`) and mirrors the WALK structure of `computeWorkItemValidity`
// (the subtree rule) and `computeSprintValidity` (the sprint rule). The only
// difference is the data source: instead of reading members/edges straight from
// the DB, it builds an in-memory VIRTUAL graph (never persisted) by applying the
// plan's `add` / `modify` / `remove` ops — resolving temp-refs through the EXACT
// `TEMP_REF_PREFIX` contract `materialize` uses — and runs the same walks over it.
//
// Projection semantics (kept explicit, and matching `materialize`):
//   • `add`    → a NEW not-done node under `resolve(parentRef)` with `blocked_by`
//                = `resolve(blockedByRefs)`. It lands in the BACKLOG (no sprint),
//                so it is NOT a sprint member unless a future field says so.
//   • `modify` → `patch.parentRef` moves the target (so the SUBTREE walk sees the
//                post-move containment) and `patch.blockedByAdd` /
//                `blockedByRemove` change its edge set; the rest
//                (title/priority/type/storyPoints/estimateMinutes) do not affect
//                finishability. Sparse: an absent key leaves the live value.
//   • `remove` → the target node AND every edge touching it are dropped (a removed
//                item neither gates nor is gated — single-node, like archive).
//   • a temp-ref `planItem:<id>` resolves to that same-plan `add`; a real id to
//                itself.
//
// A blocker named in the verdict may be a `planItem:<id>` temp-ref when the gating
// node is a not-yet-materialized `add` — the DTO's `item` / `blockedBy` are plain
// strings, so no schema change is needed (the contract, 7.28.3).
//
// ⚠️ The PROJECTION moved to `lib/services/planProjectionService.ts` (MOTIR-3096)
// when the projected READS became its second consumer. Its semantics — the three
// op kinds, temp-ref resolution, the never-persisted contract — are documented
// there, verbatim from here, and are unchanged by the move.

/** Stable wire order: by gated item, then by blocker. */
/**
 * The PROJECTED twin of `workItemsService`'s `computeSoftBlocks` (MOTIR-6368):
 * every open projected `blocked_by` edge owned by a projected ANCESTOR of
 * `rootId` — a SOFT block, reported and never gating. "Open" = `!isDone` (the
 * committed twin's not-in-its-project's-terminal-set). An ancestor or blocker
 * may be a plan `add`: its key is the `planItem:<id>` temp-ref and its title the
 * proposed one; a committed node's title is its stored one, read in ONE batch.
 * A root the plan removes has no projected node and so no chain → `[]`.
 */
async function projectedSoftBlocks(
  proj: Projection,
  rootId: string,
  ctx: ServiceContext,
): Promise<WorkItemSoftBlockDto[]> {
  const pairs: Array<{ via: ProjectedNode; blocker: ProjectedNode }> = [];
  const guard = new Set<string>([rootId]); // cycle guard (parentId is acyclic, but be safe)
  let cursor = proj.nodes.get(rootId)?.parentId ?? null;
  while (cursor !== null && !guard.has(cursor)) {
    guard.add(cursor);
    const via = proj.nodes.get(cursor);
    if (!via) break;
    for (const blockerId of proj.blockedBy.get(cursor) ?? []) {
      // Every projected edge target resolves (the MOTIR-3123 projection invariant).
      const blocker = proj.nodes.get(blockerId)!;
      if (!isDone(proj, blocker)) pairs.push({ via, blocker });
    }
    cursor = via.parentId;
  }
  if (pairs.length === 0) return [];
  const realIds = [...new Set(pairs.flatMap((p) => [p.via.id, p.blocker.id]))].filter(
    (id) => !id.startsWith(TEMP_REF_PREFIX),
  );
  const storedTitles = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findTitlesByIds(realIds, ctx.workspaceId, tx),
      )
    ).map((r) => [r.id, r.title]),
  );
  const ref = (node: ProjectedNode) => ({
    key: node.identifier,
    title:
      proj.proposalByRef.get(node.id)?.proposedFields?.title ?? storedTitles.get(node.id) ?? '',
  });
  return pairs
    .map(({ via, blocker }) => ({
      via: ref(via),
      blockedBy: ref(blocker),
      blockerStatus: blocker.status,
    }))
    .sort(
      (a, b) =>
        a.via.key.localeCompare(b.via.key) || a.blockedBy.key.localeCompare(b.blockedBy.key),
    );
}

function sortBlockers(blockers: SprintBlockerDto[]): SprintBlockerDto[] {
  return blockers.sort(
    (a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy),
  );
}

/**
 * The PROSE-vs-GRAPH advisories (MOTIR-1969) over the PROJECTED tree — the
 * projected twin of `computeSubtreeProseAdvisories` in `workItemsService`, and
 * the reason the check is worth having here at all: the planner can see the gap
 * BEFORE it materializes, which is the moment the miss is cheapest to fix.
 *
 * Same rule, projected inputs. A member's body is the PROJECTED one — an `add`'s
 * proposed text or a `modify`'s patched text (both in `proj.projectedDescription`),
 * falling back to the stored body for an untouched real node. Exempt per member:
 * itself, its projected ANCESTOR chain, and its projected `blocked_by` set. Both
 * the SCANNED card and the REFERENCE may be a `planItem:<id>` temp-ref — a
 * projected body names a projected sibling with the intra-plan token form, which
 * `bodyReferenceSeverities` keys by that same temp-ref, so an `add` that names a
 * sibling `add` without wiring `blockedByRefs` is caught exactly like a live one.
 *
 * ⚠️ ADVISORY, NEVER A BLOCKER — the verdict above is computed without it.
 *
 * `validateProjectedPlan` (the FOREST verdict) deliberately carries no
 * advisories: an advisory is a per-CARD property (this body vs this card's
 * edges) and the forest has no single subject. Per-card coverage is the
 * `validateProjectedWorkItem` call above.
 */
/**
 * One projected SIZING column (MOTIR-3110) — the plan's value where the plan
 * sets one, else the stored one.
 *
 * Sparse-patch semantics, identical to the projected body and `type` above: an
 * `add`'s `proposedFields` is the ONLY shape there is (absent ⇒ `null`), while a
 * `modify`'s patch counts only when the KEY is present — `'storyPoints' in patch`
 * — so an explicit `null` reads as *the plan clears this estimate* and an absent
 * key leaves the stored number standing.
 */
function projectedSizing(
  proj: Projection,
  nodeId: string,
  field: 'storyPoints' | 'estimateMinutes',
  stored: number | null,
): number | null {
  const proposal = proj.proposalByRef.get(nodeId);
  if (proposal) return proposal.proposedFields?.[field] ?? null;
  const patch = proj.patchByWorkItemId.get(nodeId);
  if (patch && field in patch) return patch[field] ?? null;
  return stored;
}

/**
 * The SECTION findings (MOTIR-9032) over the PROJECTED tree: each scanned
 * not-done node's projected body parsed against the registry for its projected
 * kind × type. Same layering as every projected read above — the plan's value
 * where the plan sets one, the stored row otherwise — and one batched read for
 * the real nodes. ADVISORY: never an input to a verdict.
 */
async function projectedSectionFindings(
  proj: Projection,
  nodeIds: Iterable<string>,
  ctx: ServiceContext,
): Promise<SectionFindingDto[]> {
  const scanned = [...nodeIds]
    .map((id) => proj.nodes.get(id))
    .filter((n): n is ProjectedNode => n !== undefined && !isDone(proj, n));
  if (scanned.length === 0) return [];
  const storedRows = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findDescriptionsByIds(
          scanned.filter((n) => !n.id.startsWith(TEMP_REF_PREFIX)).map((n) => n.id),
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((r) => [r.id, r] as const),
  );
  return sectionFindingsFor(
    scanned.map((node) => {
      const stored = storedRows.get(node.id);
      return {
        item: node.identifier,
        kind: node.kind,
        type: proj.projectedType.has(node.id)
          ? (proj.projectedType.get(node.id) ?? null)
          : (stored?.type ?? null),
        descriptionMd: proj.projectedDescription.has(node.id)
          ? (proj.projectedDescription.get(node.id) ?? null)
          : (stored?.descriptionMd ?? null),
      };
    }),
  );
}

async function projectedProseAdvisories(
  proj: Projection,
  memberIds: ReadonlySet<string>,
  ctx: ServiceContext,
): Promise<WorkItemProseAdvisoryDto[]> {
  // Only NOT-done members are scanned — the same filter the blocker walk uses.
  const scanned = [...memberIds]
    .map((id) => proj.nodes.get(id))
    .filter((n): n is ProjectedNode => n !== undefined && !isDone(proj, n));
  if (scanned.length === 0) return [];

  // Stored rows for every REAL member scanned. A `modify` whose body the plan
  // re-writes still needs its stored `type` / `executor` (the patch may touch
  // neither), so the read is keyed on "is this node real", not on "is its body
  // projected" — one batched read either way.
  const needsStoredRow = scanned.filter((n) => !n.id.startsWith(TEMP_REF_PREFIX)).map((n) => n.id);
  const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findDescriptionsByIds(needsStoredRow, ctx.workspaceId, tx),
  );
  const storedRows = new Map(rows.map((r) => [r.id, r] as [string, (typeof rows)[number]]));

  // The SELF-BLOCKING-DESIGN check's edge half (MOTIR-3625), projected. A
  // blocker's type comes from the PLAN wherever the plan sets one — an `add`
  // proposing the very `type: design` card this lift creates is the commonest
  // shape a plan-time author has, and it has no stored row at all — and from the
  // stored row otherwise. Only the REAL blockers the read above did not already
  // fetch are looked up, and by TYPE alone rather than by body.
  const blockerIds = new Set<string>();
  for (const node of scanned) {
    for (const blockerId of proj.blockedBy.get(node.id) ?? []) blockerIds.add(blockerId);
  }
  const storedBlockerTypes = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findTypesByIds(
          [...blockerIds].filter((id) => !id.startsWith(TEMP_REF_PREFIX) && !storedRows.has(id)),
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((r) => [r.id, r.type]),
  );
  const blockerType = (id: string): string | null =>
    proj.projectedType.has(id)
      ? (proj.projectedType.get(id) ?? null)
      : (storedRows.get(id)?.type ?? storedBlockerTypes.get(id) ?? null);

  const subjects = scanned.map((node) => {
    const exemptIds = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId !== null && !exemptIds.has(parentId)) {
      exemptIds.add(parentId);
      parentId = proj.nodes.get(parentId)?.parentId ?? null;
    }
    for (const blockerId of proj.blockedBy.get(node.id) ?? []) exemptIds.add(blockerId);
    const stored = storedRows.get(node.id);
    return {
      item: node.identifier,
      kind: node.kind,
      descriptionMd: proj.projectedDescription.has(node.id)
        ? (proj.projectedDescription.get(node.id) ?? null)
        : (stored?.descriptionMd ?? null),
      // The MISLABELLED-LINK check's second body (MOTIR-9938), layered the same
      // way: the plan's explanation where it sets one, the stored one otherwise.
      explanationMd: proj.projectedExplanation.has(node.id)
        ? (proj.projectedExplanation.get(node.id) ?? null)
        : (stored?.explanationMd ?? null),
      exemptIds,
      // Projected shape wins where the plan sets one; stored otherwise.
      type: proj.projectedType.has(node.id)
        ? (proj.projectedType.get(node.id) ?? null)
        : (stored?.type ?? null),
      executor: proj.projectedExecutor.has(node.id)
        ? (proj.projectedExecutor.get(node.id) ?? null)
        : (stored?.executor ?? null),
      // The REPO-STRADDLE repository set (MOTIR-2177, widened to a SET in
      // MOTIR-2728) is the STORED value or nothing — there is no projected
      // counterpart and that is not a gap. A proposal carries a
      // `targetRepoRole`, resolved to a repo NAME only at materialize, so an
      // `add` has no name to contradict: it takes the unpinnable arm, which is
      // exactly gate 1's question about a card whose deliverables you can
      // enumerate but whose repo you cannot.
      targetRepos: stored?.targetRepos ?? [],
      // The SUBSUMPTION check's inputs (MOTIR-2903) — STORED only, and null for
      // a not-yet-materialized `add`, which is the honest answer: a card that
      // does not exist yet has no pull requests of its own to exclude and no
      // filing instant to measure a merge against, so the check is SKIPPED for
      // it rather than run on a substituted date. A `modify` of a real row keeps
      // both, so an existing card being re-planned is still checked.
      id: stored?.id ?? null,
      createdAt: stored?.createdAt ?? null,
      // The ESTIMATION-GATE check (MOTIR-3110), projected. Sizing has BOTH a
      // proposed and a patched form — an `add` carries `proposedFields`, a
      // `modify` may re-scope the stored numbers — so the plan's value wins
      // wherever the plan sets one, with the same sparse-patch semantics the
      // body and `type` use above. This is the earliest moment an over-sized
      // card can be seen at all: the author sealing the plan, before the card
      // has a key.
      storyPoints: projectedSizing(proj, node.id, 'storyPoints', stored?.storyPoints ?? null),
      estimateMinutes: projectedSizing(
        proj,
        node.id,
        'estimateMinutes',
        stored?.estimateMinutes ?? null,
      ),
      // Children come from the PROJECTED adjacency, never the stored row: a plan
      // that `add`s a child under a leaf makes it a container, and a plan that
      // `remove`s a container's last child makes it a leaf. Both are exactly the
      // questions the gate asks, and only the projection can answer them.
      hasChildren: (proj.childrenByParent.get(node.id)?.length ?? 0) > 0,
      // The SELF-BLOCKING-DESIGN check's edge half (MOTIR-3625), off the SAME
      // projected adjacency the exempt walk above consumes — so a plan that
      // LIFTS a card's design into a proposed sibling and wires the edge in the
      // same batch stops the advisory at authoring time, which is the earliest
      // moment the remedy exists.
      hasDesignBlocker: [...(proj.blockedBy.get(node.id) ?? [])].some(
        (blockerId) => blockerType(blockerId) === 'design',
      ),
      // The BODY-EDIT-ABOVE-FIELD-MOVE check (MOTIR-5399) reads the STORED trail,
      // and a `modify` that rewrites a body or moves a watched field lands a newer
      // write on approve — so for that card the stored finding describes a row the
      // plan is about to change, and is not reported.
      trailSuperseded: touchesBodyOrWatchedField(
        Object.keys(proj.patchByWorkItemId.get(node.id) ?? {}),
      ),
      blockerCount: proj.blockedBy.get(node.id)?.size ?? 0,
      // The POST-MERGE-CHILD check (MOTIR-8863), off the PROJECTED parent — so a
      // plan that lays a production-verify card under a story is told at
      // authoring time, before approval.
      parent: (() => {
        const p = node.parentId ? proj.nodes.get(node.parentId) : undefined;
        return p ? { identifier: p.identifier, kind: p.kind } : null;
      })(),
    };
  });

  // Resolve every reference that lives in the PROJECTION against the projection
  // (that is what makes a temp-ref resolvable, and what makes a `modify`'s
  // projected status win over the stored one). Carried-in cross-project blocker
  // nodes are deliberately EXCLUDED: they entered the projection off a live edge
  // with no browse check, so they go through the advisory service's batched read
  // and its `filterBrowsable` gate instead — no existence leak.
  const localRefs = new Map<string, ProseAdvisoryLocalRef>();
  for (const node of proj.nodes.values()) {
    if (node.projectId !== proj.projectId) continue;
    localRefs.set(node.id, {
      identifier: node.identifier,
      status: node.status,
      done: isDone(proj, node),
    });
  }

  return buildProseVsGraphAdvisories(subjects, ctx, localRefs);
}

/**
 * A node's PROJECTED title (MOTIR-5403) — an `add`'s proposed title or a
 * `modify`'s patched one — or `undefined` when the plan leaves the stored title
 * standing. `PlanItemPatch.title` is optional and not nullable (a title cannot be
 * cleared), so presence is the whole sparse rule.
 */
function projectedTitle(proj: Projection, nodeId: string): string | undefined {
  const proposal = proj.proposalByRef.get(nodeId);
  // `!`: `addProposals` rejects an `add` without `proposedFields`, and `title` is
  // its one required key — the invariant `rowOf`'s null-object states once.
  if (proposal) return proposal.proposedFields!.title;
  return proj.patchByWorkItemId.get(nodeId)?.title;
}

/**
 * The CONTAINER-COVERAGE advisories over the PROJECTED subtree (MOTIR-5403) —
 * the projected twin of `computeSubtreeCoverageAdvisories` in
 * `workItemsService`, deciding through the SAME pure `containerCoverageFinding`.
 * It exists because adoption happens at PLAN time: an author re-parents an
 * existing card under a container, and this call is the one an authoring agent
 * is told to make before sealing. The committed check fires only after approve,
 * once the adopted child is already sealed under the container.
 *
 * Same rule, projected inputs:
 *   • CONTAINERS are the not-done members with PROJECTED children, so a card a
 *     plan re-parents is a child here before it is one in the tree;
 *   • a container's BODY is the plan's where the plan sets one (an `add`'s
 *     proposed body, a `modify`'s patched one), else the stored one — the rule
 *     the prose subjects above already follow;
 *   • a child's TITLE is its proposal's or a `modify`'s patched title, else the
 *     stored one;
 *   • ADOPTION compares filing instants, and a proposal's is {@link NOT_YET_FILED}:
 *     a proposed child is never adopted, and a stored child under a stored
 *     container compares the two stored `createdAt`s, as the committed path does.
 *
 * ⚠️ A STORED child under a PROPOSED container has no code path, and needs none:
 * the append refuses a `planItem:` `patch.parentRef` (`assertReparentLegal`) and
 * an `add` only creates new nodes, so the projection never produces that shape.
 * The filing instant still gives it an answer — adopted — and the pure test pins it.
 *
 * Two reads at most, both over STORED ids: the containers' bodies and filing
 * instants, then the titles of the children of containers that carry criteria.
 *
 * ⚠️ ADVISORY, NEVER A BLOCKER — the verdict is computed before this runs and
 * nothing reads it back.
 */
async function projectedCoverageAdvisories(
  proj: Projection,
  memberIds: ReadonlySet<string>,
  ctx: ServiceContext,
): Promise<WorkItemCoverageAdvisoryDto[]> {
  const containers = [...memberIds]
    .map((id) => proj.nodes.get(id)!)
    .filter((node) => !isDone(proj, node) && proj.childrenByParent.has(node.id));
  if (containers.length === 0) return [];

  const isStored = (id: string) => !id.startsWith(TEMP_REF_PREFIX);
  const storedContainers = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findDescriptionsByIds(
          containers.map((node) => node.id).filter(isStored),
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((row) => [row.id, row] as const),
  );
  const eligible = containers.flatMap((node) => {
    const row = storedContainers.get(node.id);
    // A node with no projected body is a stored one, whose row the read above holds.
    const descriptionMd = proj.projectedDescription.has(node.id)
      ? (proj.projectedDescription.get(node.id) ?? null)
      : row!.descriptionMd;
    if (acceptanceCriteriaTexts(descriptionMd).length === 0) return [];
    return [{ node, descriptionMd, createdAt: row?.createdAt ?? NOT_YET_FILED }];
  });
  if (eligible.length === 0) return [];

  const storedChildren = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findTitlesByIds(
          eligible.flatMap(({ node }) => proj.childrenByParent.get(node.id)!).filter(isStored),
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((row) => [row.id, row] as const),
  );

  const advisories: WorkItemCoverageAdvisoryDto[] = [];
  for (const { node, descriptionMd, createdAt } of eligible) {
    const children: CoverageChild[] = proj.childrenByParent.get(node.id)!.map((id) => {
      const row = storedChildren.get(id);
      return {
        identifier: proj.nodes.get(id)!.identifier,
        title: projectedTitle(proj, id) ?? row!.title,
        createdAt: row?.createdAt ?? NOT_YET_FILED,
      };
    });
    const finding = containerCoverageFinding({ descriptionMd, createdAt }, children);
    if (!finding) continue;
    for (const criterionIndex of finding.unownedCriterionIndices) {
      advisories.push({
        kind: 'coverage',
        item: node.identifier,
        severity: 'likely-unowned-criterion',
        criterionIndex,
        adoptedChildren: finding.adoptedChildren,
      });
    }
  }
  // Deterministic wire order, the committed path's: by container, then by criterion.
  advisories.sort((a, b) => a.item.localeCompare(b.item) || a.criterionIndex - b.criterionIndex);
  return advisories;
}

/**
 * The TITLE-COVERAGE advisories for a PROJECTED subtree (MOTIR-8647) — the same
 * question the committed verdict asks (does a container's body mention each
 * distinguishing word its title carries?), put to the tree the plan would leave,
 * so a plan that narrows a story's body is told before approval rather than after.
 *
 * ⚠️ ADVISORY, NEVER A BLOCKER.
 */
async function projectedTitleCoverageAdvisories(
  proj: Projection,
  memberIds: ReadonlySet<string>,
  ctx: ServiceContext,
): Promise<WorkItemTitleCoverageAdvisoryDto[]> {
  const containers = [...memberIds]
    .map((id) => proj.nodes.get(id)!)
    .filter((node) => !isDone(proj, node) && proj.childrenByParent.has(node.id));
  if (containers.length === 0) return [];

  const storedIds = containers
    .map((node) => node.id)
    .filter((id) => !id.startsWith(TEMP_REF_PREFIX));
  const storedBodies = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findDescriptionsByIds(storedIds, ctx.workspaceId, tx),
      )
    ).map((row) => [row.id, row.descriptionMd] as const),
  );
  const storedTitles = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findTitlesByIds(storedIds, ctx.workspaceId, tx),
      )
    ).map((row) => [row.id, row.title] as const),
  );

  const advisories: WorkItemTitleCoverageAdvisoryDto[] = [];
  for (const node of containers) {
    const title = projectedTitle(proj, node.id) ?? storedTitles.get(node.id);
    if (title === undefined) continue;
    const descriptionMd = proj.projectedDescription.has(node.id)
      ? (proj.projectedDescription.get(node.id) ?? null)
      : (storedBodies.get(node.id) ?? null);
    const words = unnamedTitleWords(title, descriptionMd);
    if (words.length === 0) continue;
    advisories.push({
      kind: 'title-coverage',
      item: node.identifier,
      severity: 'likely-unnamed-title-part',
      words,
    });
  }
  advisories.sort((a, b) => a.item.localeCompare(b.item));
  return advisories;
}

/**
 * Which projected edges does the PLAN own (MOTIR-7727)? The edge findings
 * below — `invalidEdges` and `crossLevelEdges` — judge the tree the plan would
 * leave, and that tree holds every edge anyone ever drew in the project. A plan
 * validation answers *"is this PLAN sound?"*, so it reports only the findings
 * the plan could have caused; the committed `validate_work_item` (no `planId`)
 * still reports the whole subtree's edges, untouched.
 *
 * Ownership is the TOUCHED SET T:
 * - every `add` (its temp-ref);
 * - every `modify` whose patch carries an EDGE key — `parentRef`,
 *   `blockedByAdd` or `blockedByRemove`. The patch KEYS are read, not the mere
 *   presence of a patch: a title- or body-only `modify` moves no edge;
 * - every `remove` target.
 *
 * An edge `item → blocker` is OWNED when T holds either end, or any node in
 * either end's projected ancestor chain — the chain both edge rules read (the
 * coverage test asks the parents up to the common one; the level test reads
 * depth). A removed parent is the one link the projected chain cannot show (the
 * node is gone from `proj.nodes`, its child's `parentId` still names it), so the
 * walk checks T BEFORE it looks the node up: a `remove` that uncovers a child
 * edge makes that edge the plan's. Likewise a `blockedByRemove` on parent B puts
 * B in T, and B sits in the chain of every child edge it covered.
 *
 * Chosen over *"projected findings minus the committed-only findings"* (the
 * other shape the card allowed): a diff keyed by `(item, blockedBy)` hides a
 * still-bad edge whose endpoint the plan re-wired, which this predicate reports.
 */
function planOwnsEdge(proj: Projection): (blockedId: string, blockerId: string) => boolean {
  const touched = new Set<string>(proj.proposalByRef.keys());
  for (const [id, patch] of proj.patchByWorkItemId) {
    if (EDGE_PATCH_KEYS.some((k) => k in patch)) touched.add(id);
  }
  for (const id of proj.removedIds) touched.add(id);
  const reaches = (id: string): boolean => {
    const seen = new Set<string>();
    for (let cur: string | null = id; cur !== null && !seen.has(cur); ) {
      if (touched.has(cur)) return true;
      seen.add(cur);
      cur = proj.nodes.get(cur)?.parentId ?? null;
    }
    return false;
  };
  return (blockedId, blockerId) => reaches(blockedId) || reaches(blockerId);
}

/** The `modify` patch keys that move an edge or a position (MOTIR-7727). */
const EDGE_PATCH_KEYS = ['parentRef', 'blockedByAdd', 'blockedByRemove'] as const;

/**
 * The UNCOVERED CROSS-PARENT edges over a projection (Story MOTIR-6015 ·
 * MOTIR-6370) — the committed walk's twin (`workItemsService`'s
 * `computeInvalidEdges`), asked of the tree the plan would leave: proposed
 * parents, proposed kinds, and every way a plan adds or removes an edge (an
 * `add`'s `blockedByRefs`, a `modify`'s `blockedByAdd` / `blockedByRemove`, on a
 * child or on a parent) are already folded into `proj.blockedBy` and
 * `proj.nodes`. No read: the projection holds the whole project.
 *
 * A carried-in cross-project blocker has no projected parent, so its edge is
 * exempt — there is no parent edge the plan could be asked for. A proposal is
 * named by its temp-ref, as everywhere else in this service.
 *
 * Only edges the plan OWNS are judged (`owns`, {@link planOwnsEdge}): the
 * parents' edges the coverage test reads are still the whole projection's, so
 * an owned edge is covered exactly as it would be after approve.
 */
function projectedInvalidEdges(
  proj: Projection,
  memberIds: ReadonlySet<string>,
  owns: (blockedId: string, blockerId: string) => boolean,
): InvalidEdgeDto[] {
  const edges: CoverageEdge[] = [];
  for (const memberId of memberIds) {
    const member = proj.nodes.get(memberId)!;
    if (isDone(proj, member)) continue;
    for (const blockerId of proj.blockedBy.get(memberId) ?? []) {
      if (proj.nodes.has(blockerId) && owns(memberId, blockerId)) {
        edges.push({ blockedId: memberId, blockerId });
      }
    }
  }
  const node = (id: string) => proj.nodes.get(id);
  // Each end's PROJECTED position (MOTIR-6411): its ancestor chain up the
  // projected parents. A carried-in cross-project node has no projected parent,
  // which reads as a root — its edge is then cross-level or parent-exempt,
  // never falsely reported uncovered.
  const chainOf = (id: string): string[] => {
    const up: string[] = [];
    const seen = new Set<string>([id]);
    let cur = node(id)?.parentId ?? null;
    while (cur !== null && !seen.has(cur) && proj.nodes.has(cur)) {
      up.push(cur);
      seen.add(cur);
      cur = node(cur)!.parentId;
    }
    return up;
  };
  return uncoveredCrossParentEdges(
    edges,
    (id) => {
      const n = node(id);
      return n ? { parentId: n.parentId, ancestors: chainOf(id), kind: n.kind } : undefined;
    },
    (from, to) => proj.blockedBy.get(from)?.has(to) ?? false,
  )
    .map((e) => ({
      item: node(e.blockedId)!.identifier,
      blockedBy: node(e.blockerId)!.identifier,
      itemParent: node(node(e.blockedId)!.parentId!)?.identifier ?? node(e.blockedId)!.parentId!,
      blockerParent: node(node(e.blockerId)!.parentId!)?.identifier ?? node(e.blockerId)!.parentId!,
    }))
    .sort((a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy));
}

/**
 * The CROSS-LEVEL `blocked_by` edges over a projection (MOTIR-6509) — the
 * committed walk's twin (`workItemsService`'s `computeCrossLevelEdges`), asked of
 * the tree the plan would leave. A PROPOSED cross-level edge never gets here (the
 * append refuses it, `INVALID_PLAN_REF_GRAPH` / `cross_level`), so what this
 * reports is a COMMITTED edge the plan OWNS (MOTIR-7727, {@link planOwnsEdge}):
 * one whose end, or an ancestor of an end, the plan re-wires, re-parents or
 * removes. A committed edge the plan touches nothing of is left to the committed
 * `validate_work_item`, which still reports it.
 *
 * ⚠️ An edge to a blocker in ANOTHER project is not judged here. The projection
 * carries such a blocker in without its ancestors (`parentId: null`), so its
 * chain would read as a root and its depth would be invented; the committed
 * verdict reads the real chain and is the one that rules on it.
 */
function projectedCrossLevelEdges(
  proj: Projection,
  memberIds: ReadonlySet<string>,
  owns: (blockedId: string, blockerId: string) => boolean,
): CrossLevelEdgeDto[] {
  const edges: Array<{ blockedId: string; blockerId: string }> = [];
  for (const memberId of memberIds) {
    const member = proj.nodes.get(memberId)!;
    if (isDone(proj, member)) continue;
    for (const blockerId of proj.blockedBy.get(memberId) ?? []) {
      if (proj.nodes.get(blockerId)?.projectId === member.projectId && owns(memberId, blockerId)) {
        edges.push({ blockedId: memberId, blockerId });
      }
    }
  }
  return crossLevelEdgeFindings(edges, (id) => {
    const n = proj.nodes.get(id)!;
    const ancestors: string[] = [];
    const seen = new Set<string>([id]);
    for (let cur = n.parentId; cur !== null; ) {
      const parent = proj.nodes.get(cur);
      /* v8 ignore next -- UNREACHABLE in practice: a same-project node's parent is a live row of that project (loaded) or an `add` of this plan (projected), and a parent cycle is refused at the append. Kept so a chain the projection cannot finish is left UNJUDGED rather than given an invented depth. */
      if (!parent || seen.has(cur)) return undefined;
      ancestors.push(cur);
      seen.add(cur);
      cur = parent.parentId;
    }
    return { label: n.identifier, kind: n.kind, ancestors };
  });
}

export const planValidityService = {
  /**
   * Is the PROJECTED subtree of `targetKey` finishable, once `planId` materializes?
   * The PlanItem-stage analogue of `workItemsService.validateWorkItem` (the subtree
   * rule, MOTIR-1375): membership is the PROJECTED subtree (projected `parentId`
   * edges), and the `blocked_by` edges are the projected set. VALID ⟺ for every
   * not-done item in the subtree, every `blocked_by` dependency is satisfied — IN
   * the subtree, or (under `loose`) `done`. A blocker may be named by a
   * `planItem:<id>` temp-ref when the gating node is a not-yet-materialized `add`.
   *
   * The `targetKey` root may be a REAL committed item (resolved against the live
   * tree — the re-parent/extend case) OR a `planItem:<id>` temp-ref for a node
   * THIS plan proposes (resolved against the projection — the `add` already lives
   * in `proj.nodes`). The temp-ref path is what lets a BRAND-NEW subtree the plan
   * creates — a new epic, a new story + its new subtasks — be validated by its
   * own temp-ref, not only an existing anchor (MOTIR-1431). A target the plan
   * `remove`s projects to an empty subtree → vacuously valid. Throws
   * `WorkItemNotFoundError` for an unknown real key OR an unknown temp-ref,
   * `PlanNotFoundError` / `ProjectAccessDeniedError` from the plan read.
   */
  async validateProjectedWorkItem(
    planId: string,
    targetKey: string,
    ctx: ServiceContext,
    condition: ValidityCondition = DEFAULT_VALIDITY_CONDITION,
  ): Promise<WorkItemValidityDto> {
    const proj = await buildProjection(planId, ctx);
    const root = await resolveProjectedRoot(proj, targetKey, ctx);

    // The containing set S = the projected subtree of the root (root + descendants).
    const memberIds = new Set<string>();
    const stack: string[] = [];
    if (proj.nodes.has(root.id)) {
      memberIds.add(root.id);
      stack.push(root.id);
    }
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const childId of proj.childrenByParent.get(id) ?? []) {
        if (!memberIds.has(childId)) {
          memberIds.add(childId);
          stack.push(childId);
        }
      }
    }

    const blockers: SprintBlockerDto[] = [];
    const waits: SprintBlockerDto[] = [];
    const owns = planOwnsEdge(proj);
    const seen = new Set<string>();
    for (const memberId of memberIds) {
      const member = proj.nodes.get(memberId)!;
      if (isDone(proj, member)) continue; // only not-done members need a check
      for (const blockerId of proj.blockedBy.get(memberId) ?? []) {
        const blocker = proj.nodes.get(blockerId);
        if (!blocker) continue;
        if (gatingItemSatisfied(memberIds.has(blockerId), isDone(proj, blocker), condition))
          continue;
        const key = `${member.identifier} ${blocker.identifier}`;
        /* v8 ignore next -- UNREACHABLE: a member's blocker set is a `Set` of ids and every projected node's identifier is distinct, so one walk cannot produce the same `<item> <blocker>` key twice. Kept as the guard the SPRINT walk's `addBlocker` genuinely needs (there a member blocked_by its OWN out-of-sprint child is reached by both the edge and the children rule). Invariant asserted in tests/integration/plans/planValidityService.test.ts — 'the projection invariant behind the walks' defensive arms' (MOTIR-3123). */
        if (seen.has(key)) continue;
        seen.add(key);
        const row: SprintBlockerDto = {
          item: member.identifier,
          blockedBy: blocker.identifier,
          blockerStatus: blocker.status,
          blockerSprintId: blocker.sprintId,
        };
        blockers.push(row);
        // A WAIT (MOTIR-9021): an edge the plan does not own, so it was in place
        // before the plan and waits on a committed card still being worked.
        if (!owns(memberId, blockerId)) waits.push(row);
      }
    }
    sortBlockers(blockers);
    sortBlockers(waits);
    // Prose families first, then COVERAGE — the committed verdict's order.
    const prose = await projectedProseAdvisories(proj, memberIds, ctx);
    const coverage = await projectedCoverageAdvisories(proj, memberIds, ctx);
    const titleCoverage = await projectedTitleCoverageAdvisories(proj, memberIds, ctx);
    // Only the edge findings this PLAN owns (MOTIR-7727) — an old bad edge in
    // the subtree is the committed verdict's to report, not the plan's.
    const invalidEdges = projectedInvalidEdges(proj, memberIds, owns);
    const crossLevelEdges = projectedCrossLevelEdges(proj, memberIds, owns);
    return {
      key: root.identifier,
      valid: blockers.length === 0 && invalidEdges.length === 0 && crossLevelEdges.length === 0,
      blockers,
      ...(waits.length > 0 ? { waits } : {}),
      invalidEdges,
      crossLevelEdges,
      advisories: [...prose, ...coverage, ...titleCoverage],
      softBlocks: await projectedSoftBlocks(proj, root.id, ctx),
      sectionFindings: await projectedSectionFindings(proj, memberIds, ctx),
    };
  },

  /**
   * Is the WHOLE plan finishable once it materializes (MOTIR-1550)? The FOREST
   * analogue of `validateProjectedWorkItem` — the containing set S is the ENTIRE
   * projection, not one subtree, so a `blocked_by` edge that crosses two sibling
   * roots (a story under epic B gated by a story under epic A) is SATISFIED: both
   * materialize together, so the gating node IS in S. Iterating the single-subtree
   * rule per root would FALSE-POSITIVE every cross-root edge (the gate sits in a
   * sibling subtree, so it reads as out-of-set) — the exact defect that made a
   * per-root walk "worse than no validation" for the multi-root epic forest
   * `generate_tree` emits (blocks MOTIR-1398; refs MOTIR-844).
   *
   * S = every projected node reachable from a projected forest ROOT — a node in
   * the PLAN's own project whose projected parent is null or itself absent from
   * the projection (real epics + `add`s with a null parentRef, plus any node
   * orphaned by a `remove`). Carried-in cross-project blocker nodes (finding #21)
   * are NOT roots and NOT in S, so a not-done cross-project dependency is
   * correctly surfaced as a residual blocker; under `tight` a `done`-but-out-of-S
   * blocker is too. VALID ⟺ for every not-done member, every projected
   * `blocked_by` is IN S or (under `loose`) `done`. An empty / all-`remove`d plan
   * projects to an empty forest → vacuously valid. Throws the plan-read errors
   * (`PlanNotFoundError` / `ProjectAccessDeniedError`) from the projection build.
   */
  async validateProjectedPlan(
    planId: string,
    ctx: ServiceContext,
    condition: ValidityCondition = DEFAULT_VALIDITY_CONDITION,
    opts: { caller?: 'actor' | 'system' } = {},
  ): Promise<PlanValidityDto> {
    const proj = await buildProjection(planId, ctx, opts);

    // The containing set S = the whole projected forest of the plan's project:
    // every node reachable DOWN from a forest root. A root is a plan-project node
    // whose projected parent is null or absent (a real epic, an `add` with no
    // parentRef, or a node orphaned by a `remove`). Restricting roots to the
    // plan's OWN project keeps carried-in cross-project blocker nodes out of S, so
    // each is judged by its own done-ness, never treated as satisfied-because-
    // in-set.
    const memberIds = new Set<string>();
    const stack: string[] = [];
    for (const node of proj.nodes.values()) {
      if (node.projectId !== proj.projectId) continue; // cross-project blockers are not roots
      if (node.parentId != null && proj.nodes.has(node.parentId)) continue; // has a projected parent
      if (!memberIds.has(node.id)) {
        memberIds.add(node.id);
        stack.push(node.id);
      }
    }
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const childId of proj.childrenByParent.get(id) ?? []) {
        if (!memberIds.has(childId)) {
          memberIds.add(childId);
          stack.push(childId);
        }
      }
    }

    // The SAME per-member rule as the subtree walk, applied over the whole-forest S.
    const blockers: SprintBlockerDto[] = [];
    const waits: SprintBlockerDto[] = [];
    const owns = planOwnsEdge(proj);
    const seen = new Set<string>();
    for (const memberId of memberIds) {
      const member = proj.nodes.get(memberId)!;
      if (isDone(proj, member)) continue; // only not-done members need a check
      for (const blockerId of proj.blockedBy.get(memberId) ?? []) {
        const blocker = proj.nodes.get(blockerId);
        if (!blocker) continue;
        if (gatingItemSatisfied(memberIds.has(blockerId), isDone(proj, blocker), condition))
          continue;
        const key = `${member.identifier} ${blocker.identifier}`;
        /* v8 ignore next -- UNREACHABLE: a member's blocker set is a `Set` of ids and every projected node's identifier is distinct, so one walk cannot produce the same `<item> <blocker>` key twice. Kept as the guard the SPRINT walk's `addBlocker` genuinely needs (there a member blocked_by its OWN out-of-sprint child is reached by both the edge and the children rule). Invariant asserted in tests/integration/plans/planValidityService.test.ts — 'the projection invariant behind the walks' defensive arms' (MOTIR-3123). */
        if (seen.has(key)) continue;
        seen.add(key);
        const row: SprintBlockerDto = {
          item: member.identifier,
          blockedBy: blocker.identifier,
          blockerStatus: blocker.status,
          blockerSprintId: blocker.sprintId,
        };
        blockers.push(row);
        // A WAIT (MOTIR-9021): an edge the plan does not own, so it was in place
        // before the plan and waits on a committed card still being worked.
        if (!owns(memberId, blockerId)) waits.push(row);
      }
    }
    sortBlockers(blockers);
    sortBlockers(waits);

    // ⚠️ THE SECOND QUESTION (MOTIR-3575). Everything above answers
    // FINISHABILITY — can every item in the projected forest be finished once
    // this plan materializes? That is a real question and it is correctly
    // answered, but it is not the question a caller asks by the word `valid`.
    // APPROVABILITY is the other half: would the approve button take this plan
    // at all? Before this, `validate_plan` answered `VALID` for plans approve
    // then refused, and that yes was load-bearing — it is what made a plan
    // carrying a dangling ref safe to close (MOTIR-3560).
    //
    // Delegated rather than re-implemented, so the validator and the button can
    // never disagree about what approvable means: `checkApprovability` runs the
    // SAME `runPersistGate` `approvePlan` runs, as a read.
    const rejections = await plansService.checkApprovability(planId, ctx);

    // THE THIRD (MOTIR-6370): every same-level cross-parent edge the projected
    // parents do not carry. A validation verdict only — neither the append nor
    // approve refuses on it, because a titles-first pass appends children before
    // it may have drawn every parent edge.
    // THE FOURTH (MOTIR-6509): a committed edge that joins two levels — the same
    // verdict `validate_work_item` gives it.
    // BOTH narrowed to the edges this plan OWNS (MOTIR-7727): S above is the
    // whole project, so without it one old bad edge anywhere made every plan on
    // the project read `valid: false` with no blocker and no rejection.
    const invalidEdges = projectedInvalidEdges(proj, memberIds, owns);
    const crossLevelEdges = projectedCrossLevelEdges(proj, memberIds, owns);
    return {
      planId,
      // Every half, so a caller reading only `valid` cannot get a false green —
      // which is exactly the reading that failed here.
      valid:
        blockers.length === 0 &&
        rejections.length === 0 &&
        invalidEdges.length === 0 &&
        crossLevelEdges.length === 0,
      blockers,
      ...(waits.length > 0 ? { waits } : {}),
      rejections,
      invalidEdges,
      crossLevelEdges,
      // Only the cards the PLAN writes (an `add`, or a `modify` of a real card):
      // an untouched stored card's body is the committed verdict's to judge.
      sectionFindings: await projectedSectionFindings(
        proj,
        [...memberIds].filter((id) => proj.proposalByRef.has(id) || proj.patchByWorkItemId.has(id)),
        ctx,
      ),
    };
  },

  /**
   * The SECTION findings alone (MOTIR-9821) — the `sectionFindings` half of
   * {@link validateProjectedPlan}, over the same cards (every `add`, and every real
   * card a `modify` patches), for the authoring-state read. That read asks only
   * whether a proposal is complete, so it pays for the parse and none of the graph
   * verdicts. `plan` is the plan the caller already read and admitted.
   */
  async projectedPlanSectionFindings(
    planId: string,
    ctx: ServiceContext,
    plan?: PlanWithItemsDto,
  ): Promise<SectionFindingDto[]> {
    const proj = await buildProjection(planId, ctx, plan ? { plan } : {});
    const proposed = [...proj.nodes.keys()].filter(
      (id) =>
        proj.nodes.get(id)!.projectId === proj.projectId &&
        (proj.proposalByRef.has(id) || proj.patchByWorkItemId.has(id)),
    );
    return projectedSectionFindings(proj, proposed, ctx);
  },

  /**
   * The SHAPE advisories over every card this plan PROPOSES — each `add`, and
   * each real card a `modify` patches — for `validate_plan` and the internal
   * `validate-plan-forest` route (MOTIR-9873, widened by MOTIR-10087).
   *
   * Every `kind: 'shape'` family {@link validateProjectedWorkItem} yields for the
   * same card, keyed by the card's `item` (`planItem:<id>` for an `add`): a
   * self-blocking design, a repo straddle, an ordering violation, over-gate
   * sizing, a post-merge child, a mislabelled link and the rest. A shape entry is
   * a defect in what the card itself says or is, so it has exactly one subject
   * and needs no subtree to be read. The reference and subsumption families are
   * not shape: they name a second card or a merge, and stay
   * `validate_work_item`'s.
   *
   * ⚠️ WHY THIS EXISTS (MOTIR-10087). Both planners close on `validate_plan`
   * alone, and until this widening it carried only the mislabelled link, so a
   * proposal the detector flagged `likely-self-blocking-design` was sealed and
   * reached the runner, whose guard #4 reads a two-index shape entry as LIFT and
   * stops. The detector had spoken; nothing the planner held could hear it.
   *
   * A MISLABELLED LINK keeps its narrower scope: it is reported only on a card
   * whose description or explanation the plan sets, because a link in a body the
   * plan did not write is not the plan's (MOTIR-9938). Untouched committed cards
   * are never scanned: they are not the plan's finding (`validate_work_item`
   * reports them).
   *
   * Deliberately NOT part of {@link validateProjectedPlan}'s verdict: the
   * forest's no-advisory rule exists because a body-vs-EDGES gap has no single
   * subject there. Both callers answer `{ ...verdict, advisories }`, beside the
   * verdict and never inside it. `opts.caller` is passed to the projection
   * exactly as {@link validateProjectedPlan} takes it.
   */
  async projectedShapeAdvisories(
    planId: string,
    ctx: ServiceContext,
    opts: { caller?: 'actor' | 'system' } = {},
  ): Promise<WorkItemProseShapeAdvisoryDto[]> {
    const proj = await buildProjection(planId, ctx, opts);
    const inPlanProject = (id: string) => proj.nodes.get(id)?.projectId === proj.projectId;
    // A plan proposes a body when it sets a description OR an explanation
    // (MOTIR-9938): a `modify` that rewrites only the explanation is still the
    // plan's text, and a link in it is the plan's finding.
    const proposedBodies = new Set(
      [...proj.projectedDescription.keys(), ...proj.projectedExplanation.keys()].filter(
        inPlanProject,
      ),
    );
    const proposed = new Set(
      [...proj.proposalByRef.keys(), ...proj.patchByWorkItemId.keys(), ...proposedBodies].filter(
        inPlanProject,
      ),
    );
    const bodyItems = new Set([...proposedBodies].map((id) => proj.nodes.get(id)!.identifier));
    const advisories = await projectedProseAdvisories(proj, proposed, ctx);
    return advisories.filter(
      (a): a is WorkItemProseShapeAdvisoryDto =>
        a.kind === 'shape' && (!isMislabelledLinkAdvisory(a) || bodyItems.has(a.item)),
    );
  },

  /**
   * Every `modify` on the plan that approve will send back from built work
   * (MOTIR-10106) — the write doors' `rescopeWarnings`, asked of the whole plan so
   * a close sees any that remain. Beside the verdict, never part of it: a re-scope
   * is legitimate when what the card delivers changes. Read through the same gate
   * as the projection (`caller: 'system'` keeps the browse floor alone).
   */
  async projectedRescopeWarnings(
    planId: string,
    ctx: ServiceContext,
    opts: { caller?: 'actor' | 'system' } = {},
  ): Promise<ProposalRescopeWarningDto[]> {
    const plan =
      opts.caller === 'system'
        ? await plansService.getPlan(planId, ctx)
        : await plansService.getPlanForReader(planId, ctx);
    return proposalRescopeWarningsService.forProposals(
      plan.items,
      undefined,
      (item) => `the \`modify\` of work item ${item.workItemId ?? '(unknown)'}`,
      plan.projectId,
      ctx,
    );
  },

  /**
   * Will the active sprint be valid once `planId` materializes? The PlanItem-stage
   * analogue of `sprintsService.validateSprint` (the sprint rule, MOTIR-1374) over
   * the PROJECTED graph. Members = the current active-sprint members minus any the
   * plan `remove`s (an `add` lands in the backlog, so it is NOT a member). A
   * not-done in-sprint item is gated by an unsatisfied projected `blocked_by` edge
   * of its OWN (a HARD block — an ancestor's blocker is a SOFT block, overridable
   * with `--allow-soft-block`, and is not reported against a descendant;
   * MOTIR-6354 / MOTIR-6368) OR a not-done child that is neither done nor in the
   * sprint (the parent-ready rule, kept as is). "Satisfied" = the gating item is
   * in the sprint, or (under `loose`) done.
   *
   * Throws `NoActiveSprintError` (the project has no active sprint — nothing to
   * project a sprint over), plus the plan-read errors.
   */
  async validateProjectedSprint(
    planId: string,
    ctx: ServiceContext,
    condition: ValidityCondition = DEFAULT_VALIDITY_CONDITION,
  ): Promise<SprintValidityDto> {
    const proj = await buildProjection(planId, ctx);
    const sprint = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      sprintRepository.findActiveByProject(proj.projectId, ctx.workspaceId, tx),
    );
    if (!sprint) throw new NoActiveSprintError(proj.projectId);

    // Projected sprint members (any status) = live members minus removed; adds are
    // backlog (sprintId null) so never members.
    const members = [...proj.nodes.values()].filter((n) => n.sprintId === sprint.id);
    const memberIds = new Set(members.map((m) => m.id));
    const notDone = members.filter((m) => !isDone(proj, m));
    if (notDone.length === 0) return { sprintId: sprint.id, valid: true, blockers: [] };

    const blockers: SprintBlockerDto[] = [];
    const seen = new Set<string>();
    const addBlocker = (
      memberId: string,
      blockedByName: string,
      blockerStatus: string,
      blockerSprintId: string | null,
    ) => {
      const member = proj.nodes.get(memberId);
      if (!member) return;
      const key = `${member.identifier} ${blockedByName}`;
      if (seen.has(key)) return;
      seen.add(key);
      blockers.push({
        item: member.identifier,
        blockedBy: blockedByName,
        blockerStatus,
        blockerSprintId,
      });
    };

    // Gating via each not-done member's OWN blocked_by edges (HARD blocks only).
    for (const m of notDone) {
      for (const blockerId of proj.blockedBy.get(m.id) ?? []) {
        const blocker = proj.nodes.get(blockerId);
        if (!blocker) continue;
        if (gatingItemSatisfied(memberIds.has(blockerId), isDone(proj, blocker), condition))
          continue;
        addBlocker(m.id, blocker.identifier, blocker.status, blocker.sprintId);
      }
    }
    // The parent-ready cascade: a not-done in-sprint parent is gated by any child
    // that is neither done nor also in the sprint.
    for (const m of notDone) {
      for (const childId of proj.childrenByParent.get(m.id) ?? []) {
        const child = proj.nodes.get(childId);
        /* v8 ignore next -- UNREACHABLE: `childrenByParent` is derived from the FINAL `nodes` map (`buildProjection`), so every child id it holds resolves. Same invariant + same test as the `seen` guards above (MOTIR-3123). */
        if (!child) continue;
        if (gatingItemSatisfied(memberIds.has(childId), isDone(proj, child), condition)) continue;
        addBlocker(m.id, child.identifier, child.status, child.sprintId);
      }
    }
    sortBlockers(blockers);
    return { sprintId: sprint.id, valid: blockers.length === 0, blockers };
  },
};
