import type { Prisma, WorkItem } from '@/generated/prisma/client';
import type { PageUnresolvedItemLinkDto } from '@/lib/dto/pages';
import { motirDestinations, replaceMotirDestinations } from '@/lib/markdown/proseRanges';
import { canonicalWorkItemKey } from '@/lib/mentions/workItemRefs';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// ── The work-item links a page's MARKDOWN save writes (bug MOTIR-11281) ──────
//
// A page body names a card as `[KEY](motir:<work item id>)`. An agent writing a
// page over MCP often puts the KEY where the id belongs — `[MOTIR-9730](motir:MOTIR-9730)`
// — and the page stored it as written: every reader drew the chip as deleted, and
// the page's derived link to the card was dropped without a word, because no row
// has that id. Work-item descriptions were already normalised on write
// (`normalizeBodyRefs`, MOTIR-1440); pages were not.
//
// This is the page counterpart, run on the markdown save BEFORE the package parses
// it, so the stored body, its ProseMirror JSON and its derived links all carry the
// id:
//
//  - a `motir:` destination shaped like a key is rewritten to the id of the card
//    that key names, in any project of the workspace the writer can browse;
//  - a BARE key in prose (this page's project) becomes the chip token, exactly as
//    a work-item description's does;
//  - every `motir:` link or embed still naming no card the writer can see is
//    REPORTED, so the write tool can say so instead of storing a dead chip silently.
//
// A card in a project the writer cannot browse reads exactly like one that does not
// exist, as in the proposal link warnings (`proposalLinkWarningsService`), so a
// warning never confirms a card's existence and a rewrite never writes an id the
// writer could not have picked.

/** The id-shaped payload a work-item chip opens (`WORKITEM_HREF_RE`'s payload). */
const ITEM_ID_RE = /^[A-Za-z0-9_-]+$/;

/** What a page markdown save stores, and the item links it could not resolve. */
export interface NormalizedPageMarkdown {
  markdown: string;
  unresolvedItemLinks: PageUnresolvedItemLinkDto[];
}

/** The cards the body's `motir:` destinations name, keyed by id and by canonical key. */
interface NamedCards {
  ids: Set<string>;
  idByKey: Map<string, string>;
}

/** Read the cards the destinations name, keeping only those in browsable projects. */
async function readNamedCards(
  targets: readonly string[],
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<NamedCards> {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const target of targets) {
    const key = canonicalWorkItemKey(target);
    if (key !== null) keys.add(key);
    else if (ITEM_ID_RE.test(target)) ids.add(target);
  }
  const [keyRows, idRows] = await Promise.all([
    workItemRepository.findByIdentifiersInWorkspace([...keys], ctx.workspaceId, tx),
    workItemRepository.findByIdsInWorkspace([...ids], ctx.workspaceId, tx),
  ]);
  const rows: WorkItem[] = [...keyRows, ...idRows];
  const browsable = new Set(
    rows.length === 0
      ? []
      : (
          await projectAccessService.filterBrowsable(
            await projectRepository.findByWorkspace(ctx.workspaceId, tx),
            ctx,
            tx,
          )
        ).map((p) => p.id),
  );
  const seen = rows.filter((row) => browsable.has(row.projectId));
  return {
    ids: new Set(seen.map((row) => row.id)),
    idByKey: new Map(seen.map((row) => [row.identifier.toUpperCase(), row.id])),
  };
}

export const pageBodyRefsService = {
  /**
   * Normalise the work-item links of a page body about to be saved as markdown,
   * inside the save's transaction (`tx`, bound to the writer's workspace), and
   * report every `motir:` link that still names no card the writer can see. A
   * body with no `motir:` destination and no bare key comes back unchanged with
   * no query.
   */
  async normalizeMarkdown(
    input: { markdown: string; projectId: string; projectIdentifier: string },
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
  ): Promise<NormalizedPageMarkdown> {
    const destinations = motirDestinations(input.markdown);
    let markdown = input.markdown;
    const unresolvedItemLinks: PageUnresolvedItemLinkDto[] = [];
    if (destinations.length > 0) {
      const named = await readNamedCards(
        destinations.map((d) => d.target),
        ctx,
        tx,
      );
      markdown = replaceMotirDestinations(markdown, (target) => {
        const key = canonicalWorkItemKey(target);
        return key === null ? null : (named.idByKey.get(key) ?? null);
      });
      const reported = new Set<string>();
      for (const { kind, label, target } of destinations) {
        const key = canonicalWorkItemKey(target);
        const resolved = key === null ? named.ids.has(target) : named.idByKey.has(key);
        const link = `${kind === 'image' ? '!' : ''}[${label}](motir:${target})`;
        if (resolved || reported.has(link)) continue;
        reported.add(link);
        unresolvedItemLinks.push({ link, label, target });
      }
    }
    const [normalized] = await normalizeBodyRefs(
      {
        projectId: input.projectId,
        projectIdentifier: input.projectIdentifier,
        fields: [markdown],
      },
      tx,
    );
    return { markdown: normalized ?? markdown, unresolvedItemLinks };
  },
};
