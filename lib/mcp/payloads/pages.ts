import { z } from 'zod/v4';
import {
  pageArchiveResultSchema,
  pageLinkPairSchema,
  pagePlacementResultSchema,
  pageRestoreResultSchema,
  pageSearchResultSchema,
  type V1PageArchive,
  type V1PageLinkPair,
  type V1PagePlacement,
  type V1PageRestore,
  type V1PageSearchResult,
} from '@/lib/api/v1/pages/schema';
import { definePayload } from './define';

// The `search_pages` payload (Story MOTIR-9489 · MOTIR-9553). `/api/v1`
// publishes one full-text hit as `PageSearchHit` (MOTIR-9552), and the tool
// returns the same page of hits the REST route does — so each hit PROBES that
// resource: the drift guard compares the MCP hit with the v1 one directly, and a
// field added on one surface and forgotten on the other fails the build. The
// envelope IS v1's `pageSearchResultSchema` (MOTIR-9575) — `items`, `nextCursor`,
// and the `mode` / `message` that say whether meaning took part — reused, not
// redeclared, so the two doors cannot disagree about it.
//
// The page READ and WRITE tools stay EXEMPT (`exemptions.ts`): they return a
// superset of v1's `Page`, which a search hit is not.

/** One page of `search_pages` hits — v1's search result, each hit a `PageSearchHit`. */
export const searchPagesPayload = definePayload({
  schema: pageSearchResultSchema as unknown as z.ZodType<
    V1PageSearchResult & Record<string, unknown>
  >,
  probes: [
    { resource: 'PageSearchHit', select: (p) => p.items },
    { resource: 'PageSearchResult', select: (p) => [p] },
  ],
});

// The `move_page` payload (Story MOTIR-9487 · MOTIR-9556). `PATCH /api/v1/pages/
// {pageId}/placement` publishes where a move left the page as `PagePlacement`
// (MOTIR-9495), and the tool returns the same placement through v1's own
// presenter — so the payload IS that resource and PROBES it whole.

/** Where a `move_page` left the page — v1's `PagePlacement`. */
export const movePagePayload = definePayload({
  schema: pagePlacementResultSchema as unknown as z.ZodType<
    V1PagePlacement & Record<string, unknown>
  >,
  probes: [{ resource: 'PagePlacement', select: (p) => [p] }],
});

// The `archive_page` payload (Story MOTIR-9487 · MOTIR-9557; probes MOTIR-9604).
// One tool serves archive AND restore, and `/api/v1` publishes each half as its
// own resource — `PageArchive` and `PageRestore` (MOTIR-9566). So the payload is
// the UNION of the two v1 schemas, and each branch PROBES its own resource: an
// archive result is checked against `PageArchive`, a restore result against
// `PageRestore`, and a field added to either REST answer and forgotten here fails
// the drift guard. The tool presents both halves through v1's own presenters.

/** What an `archive_page` took or brought back — v1's `PageArchive` or `PageRestore`. */
export type ArchivePagePayload = (V1PageArchive | V1PageRestore) & Record<string, unknown>;

/** The archive branch — the only one carrying `archivedIds`. */
function isArchiveResult(p: ArchivePagePayload): p is V1PageArchive & Record<string, unknown> {
  return 'archivedIds' in p;
}

export const archivePagePayload = definePayload({
  schema: z.union([
    pageArchiveResultSchema,
    pageRestoreResultSchema,
  ]) as unknown as z.ZodType<ArchivePagePayload>,
  probes: [
    { resource: 'PageArchive', select: (p) => (isArchiveResult(p) ? [p] : []) },
    { resource: 'PageRestore', select: (p) => (isArchiveResult(p) ? [] : [p]) },
  ],
});

// The `link_page` payload (Story MOTIR-9487 · MOTIR-9558; probes MOTIR-9604).
// `/api/v1` answers a link or an unlink with the bare pair, `PageLinkPair`
// (MOTIR-9567). The tool adds the two fields an agent reads — which `action` ran
// and whether it `changed` anything (an idempotent re-link does not) — so the
// payload is a `.extend` of that resource and PROBES the pair inside it.

/** The `link_page` answer — v1's `PageLinkPair`, plus `action` and `changed`. */
export const linkPagePayload = definePayload({
  schema: pageLinkPairSchema.extend({
    action: z.enum(['link', 'unlink']),
    changed: z.boolean(),
  }) as unknown as z.ZodType<
    V1PageLinkPair & { action: 'link' | 'unlink'; changed: boolean } & Record<string, unknown>
  >,
  probes: [{ resource: 'PageLinkPair', select: (p) => [p] }],
});
