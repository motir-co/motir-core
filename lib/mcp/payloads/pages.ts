import { z } from 'zod/v4';
import {
  pagePlacementResultSchema,
  pageSearchResultSchema,
  type V1PagePlacement,
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
// The other page tools stay EXEMPT (`exemptions.ts`): they return a superset of
// v1's `Page`, which a search hit is not.

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
