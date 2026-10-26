import { z } from 'zod/v4';
import type { ZodType } from 'zod/v4';
import { PAGE_SEARCH_QUERY_MAX_LENGTH } from '@/lib/pages/searchErrors';
import {
  defineOperation,
  type V1Operation,
  type V1Parameter,
} from '@/lib/api/v1/openapi/operation';
import {
  createPageBodySchema,
  movePageBodySchema,
  pagePlacementResultSchema,
  pageSchema,
  pageSearchHitSchema,
  pageSearchResultSchema,
  updatePageBodySchema,
} from '@/lib/api/v1/pages/schema';

// The PAGE operations (Story MOTIR-9486 · MOTIR-9493).
//
// Read off the routes (`app/api/v1/projects/[projectKey]/pages/route.ts`,
// `app/api/v1/pages/[pageId]/route.ts`): the permission from each `withV1Route`,
// the error statuses from the refusals `mapPageErrorToV1` renders for the
// service calls each one makes. `tests/api/v1/pages-openapi-coverage.test.ts`
// fails on a page route method with no declaration here, and on a declaration
// with no route.
//
// ⚠️ The MCP's `create_page` / `get_page` describe the SAME operations over the
// same `pagesService` doors, with the same codes. If one door changes a refusal,
// the other has to.

export const pageProjectKeyParameter: V1Parameter = {
  name: 'projectKey',
  in: 'path',
  required: true,
  description: 'The project’s key — the prefix of its work items’ keys, e.g. `MOTIR`.',
  schema: z.string().min(1),
};

export const pageIdParameter: V1Parameter = {
  name: 'pageId',
  in: 'path',
  required: true,
  description:
    'The page’s id — the `<id>` in its address `/pages/<id>`. A page has no `MOTIR-<n>` key, so its id is its name on the wire.',
  schema: z.string().min(1),
};

export const PAGE_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/pages',
    operationId: 'createPage',
    summary: 'Create a page',
    description:
      'Create a page at the project root, in a folder or under a page, appended last, with an optional markdown body — in ONE transaction, so the page never exists without the body it was created with. A parent page that is missing or in another project is `PAGE_NOT_FOUND`, and such a folder `FOLDER_NOT_FOUND` — another project’s rows are not visible from this one, so the refusal never confirms they exist. An archived parent page is `PAGE_PARENT_ARCHIVED`, a kind other than `root` · `folder` · `page` is `PAGE_PARENT_NOT_ALLOWED`, a page nested past the depth limit is `PAGE_DEPTH_EXCEEDED`. Nothing is written on a refusal. A caller who can browse the project but may not edit its pages is 403 `PROJECT_ACCESS_DENIED`. The `Location` header names the created page.',
    permission: 'page:edit',
    parameters: [pageProjectKeyParameter],
    requestBody: { schema: createPageBodySchema, description: 'The page to create.' },
    response: {
      status: 201,
      body: { kind: 'object', schema: pageSchema },
      description: 'The created page, with the `revision` to write against.',
    },
    errorStatuses: [403, 404, 413, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/pages/{pageId}',
    operationId: 'getPage',
    summary: 'Read a page',
    description:
      'One page by id: its title, where it is filed, its current `revision`, who saved its newest version, and its body as markdown. A page that never existed, a page in another project or workspace, and a page in a project the caller cannot browse are the same 404 `PAGE_NOT_FOUND` — the existence-oracle rule — and the body never names the page. A caller who can browse the project but may not view its pages is 403 `PROJECT_ACCESS_DENIED`.',
    permission: 'page:view',
    parameters: [pageIdParameter],
    response: {
      status: 200,
      body: { kind: 'object', schema: pageSchema },
      description: 'The page.',
    },
    errorStatuses: [403, 404],
  }),
  defineOperation({
    method: 'PATCH',
    path: '/api/v1/pages/{pageId}',
    operationId: 'updatePage',
    summary: 'Replace a page’s body',
    description:
      'Replace a page’s WHOLE body with markdown, stating the `revision` the caller read — the same write the MCP `update_page` makes. A page saved since that revision is 409 `PAGE_REVISION_CONFLICT` and nothing is written: read it again and reapply. An archived page is 409 `PAGE_ARCHIVED` until it is restored. A body over the size limit is 413 `PAGE_BODY_TOO_LARGE`. The title is not changed here. A page the caller cannot see is the same 404 `PAGE_NOT_FOUND` as one that never existed; a caller who can browse the project but may not edit its pages is 403 `PROJECT_ACCESS_DENIED`.',
    permission: 'page:edit',
    parameters: [pageIdParameter],
    requestBody: {
      schema: updatePageBodySchema,
      description: 'The new body and the revision it was written against.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: pageSchema },
      description: 'The page after the save, at its new `revision`.',
    },
    errorStatuses: [403, 404, 409, 413, 422],
  }),
  defineOperation({
    method: 'PATCH',
    path: '/api/v1/pages/{pageId}/placement',
    operationId: 'movePage',
    summary: 'Move a page',
    description:
      'Re-parent a page under another page, into a folder or to the project root — or reorder it among its siblings, or both — carrying its whole subtree, in ONE transaction; the session route’s move. With no neighbour, a re-parented page goes last and a page left at its own parent keeps its place; a move to where the page already is answers `moved: false` and writes nothing. Each refusal is named and moves nothing: a page under itself or one of its own sub-pages is 422 `PAGE_CYCLE`; nesting past the depth limit 422 `PAGE_DEPTH_EXCEEDED`; an archived parent page 422 `PAGE_PARENT_ARCHIVED`; a kind other than `root` · `folder` · `page` 422 `PAGE_PARENT_NOT_ALLOWED`; a neighbour that is the page itself, not at the destination or out of order 422 `PAGE_NEIGHBOUR_INVALID`; an archived page 409 `PAGE_ARCHIVED`. A parent page that is missing or in another project is 404 `PAGE_NOT_FOUND`, and such a folder 404 `FOLDER_NOT_FOUND`. A page the caller cannot see is the same 404 `PAGE_NOT_FOUND` as one that never existed; a caller who can browse the project but may not edit its pages is 403 `PROJECT_ACCESS_DENIED`.',
    permission: 'page:edit',
    parameters: [pageIdParameter],
    requestBody: {
      schema: movePageBodySchema,
      description: 'The new parent, and optionally the neighbour to land beside.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: pagePlacementResultSchema },
      description: 'Where the page now sits.',
    },
    errorStatuses: [403, 404, 409, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/pages/search',
    operationId: 'searchPages',
    summary: 'Search a project’s pages',
    description:
      'Find the project’s LIVE pages by meaning and by words. The query is matched two ways — Postgres full-text search on the title and body (words matched as typed in any language, no stemming), and similarity of meaning against each page’s embedded text — and the two rankings are merged by reciprocal-rank fusion, so a page found both ways ranks above a page found one way, and appears once. There is no similarity threshold: ranking, not filtering, is the answer. Hits are best match first and keyset-paged by an opaque `cursor`: pass back the `nextCursor` you were given, `null` when there is no further hit; no total is returned. A hit is the page’s id, title, place, a short `snippet` of the body, and its `rank` (the fused score) — never the body itself: read a page with `GET /api/v1/pages/{pageId}`. `mode` says how the hits were ranked: `merged` (words and meaning), `full-text-only` (the embedding service did not answer, so semantic search did not run) or `not-indexed` (no page of the project is indexed for meaning yet). `full-text-only` and `not-indexed` carry a `message`, and neither is evidence that no similar page exists. Archived pages and other projects’ pages never appear. ⚠️ An empty or whitespace-only `q` is REFUSED by name, 422 `PAGE_SEARCH_QUERY_EMPTY` — it never returns every page. A `q` over ' +
      PAGE_SEARCH_QUERY_MAX_LENGTH +
      ' characters is 422 `PAGE_SEARCH_QUERY_TOO_LONG`, and a cursor this API did not issue 422 `PAGE_CURSOR_INVALID`. A caller who can browse the project but may not view its pages is 403 `PROJECT_ACCESS_DENIED`, whatever the query or cursor; a project the caller cannot browse is 404 `PAGE_NOT_FOUND`. Neither refusal names a page or a count. The MCP `search_pages` tool is the same search with the same codes.',
    permission: 'page:view',
    parameters: [
      pageProjectKeyParameter,
      {
        name: 'q',
        in: 'query',
        required: true,
        description: `The words to find, at most ${PAGE_SEARCH_QUERY_MAX_LENGTH} characters. Read as plain words: punctuation and search operators are text, so no input is a syntax error, and a query of only punctuation finds nothing.`,
        schema: z.string(),
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'The `nextCursor` of the previous page; omit for the first page.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: pageSearchResultSchema },
      description: 'A page of hits, best match first, and the mode they were ranked in.',
    },
    errorStatuses: [403, 404, 422],
  }),
];

export const PAGE_COMPONENTS: Readonly<Record<string, ZodType>> = {
  Page: pageSchema,
  PagePlacement: pagePlacementResultSchema,
  PageSearchHit: pageSearchHitSchema,
  PageSearchResult: pageSearchResultSchema,
};
