import type { PlanItem, Prisma } from '@/generated/prisma/client';
import type { ProposalLinkWarningDto } from '@/lib/dto/plans';
import { InvalidProposalError } from '@/lib/plans/errors';
import {
  bodyLinkWarningLine,
  findBodyLinkCandidates,
  judgeBodyLinks,
  type BodyLinkCandidate,
  type BodyLinkResolution,
  type ProposedBodies,
} from '@/lib/plans/validateProposedBodyRefs';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { labelWorkItemKeys } from '@/lib/workItems/proseVsGraph';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// ── The item links a proposal write KEPT that would ship dead (MOTIR-10104) ──
//
// The pure half (`lib/plans/validateProposedBodyRefs.ts`) finds the links and
// judges them; this is the half that asks the database what their ids name —
// a proposal on this plan, an earlier plan's proposal that became a card
// (`plan_item.work_item_id`), or a card — so a warning can carry the exact link
// that works instead of the general format. A `motir:` link whose id names none
// of them is dead, and its label's key is resolved to the card it meant
// (MOTIR-10111).
//
// The cards are filtered through the reader's BROWSE gate, as the prose
// advisories are (`proseGraphAdvisoryService`): a card the reader cannot see
// reads exactly like one that does not exist, so a warning never leaks an id.

/** A plan item's bodies — an `add`'s proposed fields, a `modify`'s patch. */
function bodiesOf(item: PlanItem): ProposedBodies | null {
  const source = item.op === 'add' ? item.proposedFields : item.op === 'modify' ? item.patch : null;
  return source && typeof source === 'object' ? (source as ProposedBodies) : null;
}

/** Ask the database what every candidate id names, in at most four reads. */
async function resolve(
  candidates: readonly BodyLinkCandidate[],
  thisPlanAddIds: ReadonlySet<string>,
  ctx: ServiceContext,
): Promise<BodyLinkResolution> {
  const ids = [
    ...new Set(candidates.flatMap((c) => (c.id && !thisPlanAddIds.has(c.id) ? [c.id] : []))),
  ];
  const none: BodyLinkResolution = {
    thisPlanAddIds,
    becameCard: new Map(),
    cardIds: new Set(),
    knownPrefixes: new Set(),
    cardByKey: new Map(),
  };
  if (ids.length === 0) return none;
  return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const adds = await planItemRepository.findMaterializedAddsByIds(ids, ctx.workspaceId, tx);
    const rows = await workItemRepository.findByIdsInWorkspace(
      [...new Set([...ids, ...adds.map((a) => a.workItemId)])],
      ctx.workspaceId,
      tx,
    );
    // Every `motir:` link names a card or is dead (MOTIR-10111), so the
    // projects the reader can browse are read whenever one is present.
    const needProjects = rows.length > 0 || candidates.some((c) => c.scheme === 'motir');
    const projects = needProjects
      ? await projectAccessService.filterBrowsable(
          await projectRepository.findByWorkspace(ctx.workspaceId, tx),
          ctx,
          tx,
        )
      : [];
    const browsable = new Set(projects.map((p) => p.id));
    const cardIds = new Set(rows.filter((r) => browsable.has(r.projectId)).map((r) => r.id));
    const becameCard = new Map(
      adds.filter((a) => cardIds.has(a.workItemId)).map((a) => [a.id, a.workItemId]),
    );
    const knownPrefixes = new Set(projects.map((p) => p.identifier.toUpperCase()));
    const cardByKey = await cardsNamedByDeadLinks(
      candidates.filter(
        (c) =>
          c.scheme === 'motir' &&
          c.id !== null &&
          !thisPlanAddIds.has(c.id) &&
          !becameCard.has(c.id) &&
          !cardIds.has(c.id),
      ),
      projects,
      knownPrefixes,
      tx,
    );
    return { thisPlanAddIds, becameCard, cardIds, knownPrefixes, cardByKey };
  });
}

/**
 * The cards the labels of DEAD `motir:` links name by key (MOTIR-10111), read
 * only in the projects the reader can browse — so a key in a project they cannot
 * see resolves to nothing, exactly like a key that names no card. A label naming
 * several keys names no one card to correct to, and is not looked up.
 */
async function cardsNamedByDeadLinks(
  dead: readonly BodyLinkCandidate[],
  projects: readonly { id: string; identifier: string }[],
  knownPrefixes: ReadonlySet<string>,
  tx: Prisma.TransactionClient,
): Promise<Map<string, string>> {
  const keys = new Set(
    dead.flatMap((c) => {
      const named = labelWorkItemKeys(c.label, knownPrefixes);
      return named.length === 1 ? named : [];
    }),
  );
  const cardByKey = new Map<string, string>();
  for (const project of projects) {
    const prefix = project.identifier.toUpperCase();
    const identifiers = [...keys]
      .filter((k) => k.slice(0, k.lastIndexOf('-')) === prefix)
      .map((k) => `${project.identifier}-${k.slice(k.lastIndexOf('-') + 1)}`);
    if (identifiers.length === 0) continue;
    for (const row of await workItemRepository.findByIdentifiers(project.id, identifiers, tx)) {
      cardByKey.set(row.identifier.toUpperCase(), row.id);
    }
  }
  return cardByKey;
}

/** One proposal's warnings, as the wire carries them. */
interface ItemWarnings {
  item: PlanItem;
  warnings: ProposalLinkWarningDto[];
}

/**
 * Judge the bodies of `targets` (rows of the plan whose proposals are `all`).
 * `labelOf` names a proposal the way the plan's refusals do.
 */
async function judgeItems(
  all: readonly PlanItem[],
  targets: readonly PlanItem[],
  labelOf: (item: PlanItem) => string,
  ctx: ServiceContext,
  only?: BodyLinkCandidate['scheme'],
): Promise<ItemWarnings[]> {
  const perItem = targets.map((item) => {
    const bodies = bodiesOf(item);
    const found = bodies ? findBodyLinkCandidates(bodies) : [];
    return { item, candidates: only ? found.filter((c) => c.scheme === only) : found };
  });
  const flat = perItem.flatMap((p) => p.candidates);
  if (flat.length === 0) return [];
  const thisPlanAddIds = new Set(all.filter((i) => i.op === 'add').map((i) => i.id));
  const known = await resolve(flat, thisPlanAddIds, ctx);
  return perItem.flatMap(({ item, candidates }) => {
    const warnings = judgeBodyLinks(candidates, known).map((w) => ({
      planItemId: item.id,
      proposal: labelOf(item),
      ...w,
    }));
    return warnings.length ? [{ item, warnings }] : [];
  });
}

export const proposalLinkWarningsService = {
  /**
   * The warnings a proposal WRITE answers with: every broken item link in the
   * bodies of the proposals it wrote (`targetIds`), judged against the plan's
   * proposals as they now stand (`all`). Empty when every link is sound.
   */
  async forWrittenProposals(
    all: readonly PlanItem[],
    targetIds: readonly string[],
    labelOf: (item: PlanItem) => string,
    ctx: ServiceContext,
  ): Promise<ProposalLinkWarningDto[]> {
    const wanted = new Set(targetIds);
    const targets = all.filter((i) => wanted.has(i.id));
    return (await judgeItems(all, targets, labelOf, ctx)).flatMap((r) => r.warnings);
  },

  /**
   * APPROVE'S HALF (MOTIR-10104): the first proposal whose bodies still carry a
   * malformed `motir-ref:` link, as the refusal approve throws — the write doors
   * kept it as a warning, and this is what stops it shipping as dead text. A
   * `motir:` link naming one of this plan's proposals is not refused here:
   * approve rewrites it (MOTIR-9993). `null` when there is none.
   */
  async firstShippingBlocker(
    items: readonly PlanItem[],
    labelOf: (item: PlanItem) => string,
    ctx: ServiceContext,
  ): Promise<InvalidProposalError | null> {
    const [first] = await judgeItems(items, items, labelOf, ctx, 'motir-ref');
    if (!first) return null;
    return new InvalidProposalError(
      `${labelOf(first.item)}: approve would ship ${first.warnings.length} item link(s) as dead ` +
        `text — ${first.warnings.map(bodyLinkWarningLine).join('; ')}. Correct the proposal, then approve.`,
      first.item.id,
    );
  },
};
