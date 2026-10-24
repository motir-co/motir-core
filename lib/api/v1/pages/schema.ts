import { z } from 'zod/v4';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import type { PageMarkdownDto, PageParentInput } from '@/lib/dto/pages';
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
export function readPageParent(raw: CreatePageBody['parent']): PageParentInput {
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
