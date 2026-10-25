import { z } from 'zod/v4';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import type {
  PageMarkdownDto,
  PageMoveResultDto,
  PageParentInput,
  PageSearchResultDto,
} from '@/lib/dto/pages';
import { parseParentBody } from '@/lib/pages/parentInput';

// The v1 PAGE resource (Story MOTIR-9486 · MOTIR-9493) — a project's document,
// read and written as MARKDOWN with a `revision` to write against. Every page
// response and request shape is declared HERE, beside each other, because an
// OpenAPI operation is both (the folder module's reasoning).
//
// ── A v1 response is a SCHEMA's output, never a service DTO ──────────────────
// `presentPage` maps field by field. `PageMarkdownDto` carries `projectId`,
// which stays internal: a project is addressed by its KEY on the wire.
//
// ── The page id IS a cuid on the wire ───────────────────────────────────────
// A page has no `MOTIR-<n>` key — the folder resource records the same
// exception — so its id is its name: the `<id>` in its address `/pages/<id>`.
//
// ── The body is MARKDOWN, the same derivation the MCP `get_page` serves ─────
// The canonical body is the editor's Yjs state; `markdown` is the derived
// column `pagesService.getPageMarkdown` reads, so REST, the MCP and the app
// agree on every byte.

const isoDateTimeSchema = z.string().datetime();

/** Where a page is filed — at most one is set; both `null` at the project root. */
export const pagePlacementSchema = z.object({
  parentPageId: z.string().nullable(),
  folderId: z.string().nullable(),
});

/** The v1 page resource. */
export const pageSchema = z.object({
  id: z.string(),
  title: z.string(),
  placement: pagePlacementSchema,
  /** Advances by one on every save; send it back to write. */
  revision: z.number().int(),
  /** The newest version; `null` only for a page whose history predates versions. */
  latestVersion: z
    .object({
      number: z.number().int(),
      authorId: z.string(),
      authorName: z.string(),
      savedAt: isoDateTimeSchema,
    })
    .nullable(),
  markdown: z.string(),
  updatedAt: isoDateTimeSchema,
});
export type V1Page = z.infer<typeof pageSchema>;

/** Map a page to the wire resource — field by field, never a spread. */
export function presentPage(page: PageMarkdownDto): V1Page {
  return {
    id: page.id,
    title: page.title,
    placement: {
      parentPageId: page.placement.parentPageId,
      folderId: page.placement.folderId,
    },
    revision: page.revision,
    latestVersion: page.latestVersion
      ? {
          number: page.latestVersion.number,
          authorId: page.latestVersion.authorId,
          authorName: page.latestVersion.authorName,
          savedAt: page.latestVersion.savedAt,
        }
      : null,
    markdown: page.markdown,
    updatedAt: page.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST schemas
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ The schemas assert the wire TYPE only. The title cap, the body size, which
// parent kinds are allowed and every placement rule are the package's refusals
// (`PAGE_TITLE_TOO_LONG`, `PAGE_BODY_TOO_LARGE`, `PAGE_PARENT_NOT_ALLOWED`,
// `CROSS_PROJECT_PAGE_PARENT`, `PAGE_PARENT_ARCHIVED`, …), decided once, there.

/** A page's parent as a request names it. */
export const pageParentSchema = z
  .object({
    kind: z
      .string()
      .describe(
        '`root` for the project root, `folder` for a folder, `page` to nest under a page. Any other kind is `PAGE_PARENT_NOT_ALLOWED`.',
      ),
    id: z
      .string()
      .nullish()
      .describe('The folder’s or page’s id. Required for `folder` and `page`; ignored for `root`.'),
  })
  .strict();

/** `POST /api/v1/projects/{projectKey}/pages`. */
export const createPageBodySchema = z
  .object({
    title: z.string().optional().describe('The page’s title. Omit for an untitled page.'),
    markdown: z
      .string()
      .optional()
      .describe('The initial body, as markdown. Omit (or send empty) for an empty page.'),
    parent: pageParentSchema
      .optional()
      .describe('Where the page goes, appended last. Omit for the project root.'),
  })
  .strict();
export type CreatePageBody = z.infer<typeof createPageBodySchema>;

/**
 * A body's parent → the service's `PageParentInput`, through the ONE parser the
 * session doors use (`parseParentBody`). A `folder` or `page` with no id is a
 * shape problem, refused here; an unknown kind passes through so the package
 * refuses it by name.
 */
export function readPageParent(
  raw: CreatePageBody['parent'] | MovePageBody['parent'],
): PageParentInput {
  if (raw === undefined) return { kind: 'root' };
  const parent = parseParentBody(raw);
  if (!parent) {
    throw new InvalidRequestError(
      'INVALID_BODY',
      'The request body is invalid at `parent`: a `folder` or `page` parent needs its `id`.',
    );
  }
  return parent;
}

/**
 * `PATCH /api/v1/pages/{pageId}` — replace the WHOLE body, stating the revision
 * the caller read. No title: a rename is its own door, as on the MCP.
 */
export const updatePageBodySchema = z
  .object({
    markdown: z.string().describe('The page’s new body, WHOLE, as markdown.'),
    revision: z
      .number()
      .int()
      .min(1)
      .describe(
        'The `revision` the caller read (from a read or the last write). A page saved since is `PAGE_REVISION_CONFLICT` (409) and nothing is written.',
      ),
  })
  .strict();
export type UpdatePageBody = z.infer<typeof updatePageBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The MOVE (MOTIR-9495)
// ─────────────────────────────────────────────────────────────────────────────

/** A page's parent as the move reports it — the shape a request names. */
export const pageParentResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }),
  z.object({ kind: z.literal('folder'), id: z.string() }),
  z.object({ kind: z.literal('page'), id: z.string() }),
]);

/** Where a move left the page. */
export const pagePlacementResultSchema = z.object({
  id: z.string(),
  parent: pageParentResultSchema,
  /** Fractional index among the page's new siblings — opaque, but it sorts. */
  position: z.string(),
  /** The page's ancestor pages, root first, the page itself excluded. */
  ancestorPageIds: z.array(z.string()),
  /** `false` for a move to where the page already was, which writes nothing. */
  moved: z.boolean(),
});
export type V1PagePlacement = z.infer<typeof pagePlacementResultSchema>;

/** Map a move's result to the wire resource — field by field. */
export function presentPagePlacement(result: PageMoveResultDto): V1PagePlacement {
  return {
    id: result.id,
    parent:
      result.parent.kind === 'root'
        ? { kind: 'root' }
        : { kind: result.parent.kind, id: result.parent.id },
    position: result.position,
    ancestorPageIds: [...result.ancestorPageIds],
    moved: result.moved,
  };
}

const neighbourIdSchema = z.string().min(1).nullish();

/**
 * `PATCH /api/v1/pages/{pageId}/placement` — the session route's body
 * (`app/api/pages/[pageId]/placement/route.ts`): the new parent, and optionally
 * the sibling to land after (`beforeId`) or before (`afterId`).
 */
export const movePageBodySchema = z
  .object({
    parent: pageParentSchema.describe(
      'Where the page goes: `{ kind: "root" }`, `{ kind: "folder", id }` or `{ kind: "page", id }`. Its whole subtree moves with it.',
    ),
    beforeId: neighbourIdSchema.describe(
      'A page at the destination the moved page lands right AFTER. Omit to place it last (or keep its place at its own parent).',
    ),
    afterId: neighbourIdSchema.describe(
      'A page at the destination the moved page lands right BEFORE.',
    ),
  })
  .strict();
export type MovePageBody = z.infer<typeof movePageBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH (Story MOTIR-9489 · MOTIR-9552)
// ─────────────────────────────────────────────────────────────────────────────

/** Where a hit lives — the same place the Link page picker shows. */
export const pageSearchPlaceSchema = z.object({
  /** The folder chain its topmost page is filed in, root first; `[]` at the root. */
  folderPath: z.array(z.string()),
  /** Its direct parent page's title; `null` for a top-level page. */
  parentPageTitle: z.string().nullable(),
});

/** One page search hit: the page's identity and place, a snippet and a rank — never its body. */
export const pageSearchHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  place: pageSearchPlaceSchema,
  /** A short excerpt of the body around the match; `''` for a page with no body. */
  snippet: z.string(),
  /** Fused score, higher is better, comparable only within one search. */
  rank: z.number().describe('Fused score, higher is better, comparable only within one search.'),
});
export type V1PageSearchHit = z.infer<typeof pageSearchHitSchema>;

/**
 * One page of hits, and how they were ranked (MOTIR-9574) — no total. `mode`
 * says whether meaning took part; `message` says why not, and is `null` when it did.
 */
export const pageSearchResultSchema = z.object({
  items: z.array(pageSearchHitSchema),
  /** Opaque; `null` when there is no further hit. */
  nextCursor: z.string().nullable(),
  mode: z
    .enum(['merged', 'full-text-only', 'not-indexed'])
    .describe(
      '`merged`: words and meaning, fused. `full-text-only`: semantic search did not run. `not-indexed`: no page of the project is indexed for meaning yet.',
    ),
  message: z
    .string()
    .nullable()
    .describe(
      'Why semantic search did not contribute — never evidence that nothing similar exists. `null` when `mode` is `merged`.',
    ),
});
export type V1PageSearchResult = z.infer<typeof pageSearchResultSchema>;

/**
 * `GET /api/v1/projects/{projectKey}/pages/search` — WIRE types only. A missing
 * `q` is the empty string, so the service's named empty-query refusal is the one
 * answer; the cursor passes through untouched, so only the service decides
 * whether it issued it.
 */
export function readPageSearchQuery(url: URL): { q: string; cursor: string | null } {
  return { q: url.searchParams.get('q') ?? '', cursor: url.searchParams.get('cursor') };
}

/** Map a search result to the wire — field by field, never a spread. */
export function presentPageSearch(result: PageSearchResultDto): V1PageSearchResult {
  return {
    items: result.items.map((hit) => ({
      id: hit.id,
      title: hit.title,
      place: {
        folderPath: [...hit.place.folderPath],
        parentPageTitle: hit.place.parentPageTitle,
      },
      snippet: hit.snippet,
      rank: hit.rank,
    })),
    nextCursor: result.nextCursor,
    mode: result.mode,
    message: result.message,
  };
}
