import { z } from 'zod/v4';
import { pageSearchHitSchema, type V1PageSearchResult } from '@/lib/api/v1/pages/schema';
import { definePayload } from './define';

// The `search_pages` payload (Story MOTIR-9489 · MOTIR-9553). `/api/v1`
// publishes one full-text hit as `PageSearchHit` (MOTIR-9552), and the tool
// returns the same page of hits the REST route does — so each hit PROBES that
// resource: the drift guard compares the MCP hit with the v1 one directly, and a
// field added on one surface and forgotten on the other fails the build. The
// `{ items, nextCursor }` envelope stays the plain cursor envelope both doors use.
//
// The other page tools stay EXEMPT (`exemptions.ts`): they return a superset of
// v1's `Page`, which a search hit is not.

/** One page of `search_pages` hits — v1's search result, each hit a `PageSearchHit`. */
export const searchPagesPayload = definePayload({
  schema: z.object({
    items: z.array(pageSearchHitSchema),
    nextCursor: z.string().nullable(),
  }) as unknown as z.ZodType<V1PageSearchResult & Record<string, unknown>>,
  probes: [{ resource: 'PageSearchHit', select: (p) => p.items }],
});
