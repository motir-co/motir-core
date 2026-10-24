import { z } from 'zod/v4';
import type { ZodType } from 'zod/v4';
import {
  defineOperation,
  type V1Operation,
  type V1Parameter,
} from '@/lib/api/v1/openapi/operation';
import { createPageBodySchema, pageSchema, updatePageBodySchema } from '@/lib/api/v1/pages/schema';

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
];

export const PAGE_COMPONENTS: Readonly<Record<string, ZodType>> = {
  Page: pageSchema,
};
