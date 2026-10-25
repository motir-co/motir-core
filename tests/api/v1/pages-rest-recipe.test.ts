import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { pageSchema, type V1Page } from '@/lib/api/v1/pages/schema';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import type { TokenGrant } from '@/lib/tokens/grant';
import { foldersService } from '@/lib/services/foldersService';
import { pagesService } from '@/lib/services/pagesService';
import {
  createV1ProjectCaller,
  type V1Caller,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import {
  createPageV1,
  getPageV1,
  memberCaller,
  movePageV1,
  updatePageV1,
} from '../../fixtures/apiV1PageFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The story's REST verification recipe, as ONE session (Story MOTIR-9486 ·
// MOTIR-9497). An integration developer's seven steps — create, read, update,
// a stale update, three moves, a refused read, the published contract — run in
// order by one API-token caller against real Postgres, each step reading what
// the step before it wrote. The per-route refusal matrices live in the route
// suites; the seams between routes in `pages-story-gate.test.ts`.
//
// The caller holds ONLY `page:view` and `page:edit`, so a broader grant cannot
// hide a route that asks for a key the recipe does not need.

const RECIPE_GRANT: TokenGrant = ['page:view', 'page:edit'];

const TITLE = 'Integration runbook — partner sync';
const FIRST_BODY = '# Partner sync\n\nRuns nightly at 02:00.';
const SECOND_BODY = '# Partner sync\n\nRuns nightly at 03:00, after the export.';

let owner: V1ProjectCaller;
let member: V1Caller;
let outsider: V1ProjectCaller;
let otherPageId: string;
let folderId: string;

// What each step hands the next.
let pageId: string;
let readRevision: number;
let afterUpdate: V1Page;

beforeAll(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "page", "folder" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  resetRateLimitStore();

  owner = await createV1ProjectCaller({ permissions: RECIPE_GRANT });
  member = await memberCaller(owner, 'recipe', 'member', RECIPE_GRANT);
  outsider = await createV1ProjectCaller({
    workspaceName: 'Elsewhere',
    identifier: 'ELS',
    permissions: RECIPE_GRANT,
  });
  otherPageId = (
    await pagesService.createPage(owner.ctx, {
      projectId: owner.fixture.projectId,
      title: 'Integrations',
    })
  ).id;
  folderId = (
    await foldersService.createFolder(
      { projectId: owner.fixture.projectId, parentFolderId: null, name: 'Runbooks' },
      owner.ctx,
    )
  ).id;
});

afterAll(async () => {
  await adminDb.$disconnect();
});

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function read(): Promise<V1Page> {
  const res = await getPageV1(member, pageId);
  expect(res.status).toBe(200);
  return body<V1Page>(res);
}

describe('the REST verification recipe, in order', () => {
  it('1 — create with a markdown body: 201 at the project root, with a revision', async () => {
    const res = await createPageV1(member, owner.projectKey, {
      title: TITLE,
      markdown: FIRST_BODY,
    });
    expect(res.status).toBe(201);
    const page = await body<V1Page>(res);
    expect(pageSchema.safeParse(page).success).toBe(true);
    expect(page).toMatchObject({
      title: TITLE,
      placement: { parentPageId: null, folderId: null },
    });
    expect(page.revision).toBeGreaterThanOrEqual(1);
    pageId = page.id;
    readRevision = page.revision;
  });

  it('2 — read it back: the same title, the body exactly as sent, the same revision', async () => {
    const page = await read();
    expect(page.title).toBe(TITLE);
    expect(page.markdown.trim()).toBe(FIRST_BODY);
    expect(page.revision).toBe(readRevision);
  });

  it('3 — update with the read revision: 200, a greater revision, and GET returns the new body', async () => {
    const res = await updatePageV1(member, pageId, {
      markdown: SECOND_BODY,
      revision: readRevision,
    });
    expect(res.status).toBe(200);
    const saved = await body<V1Page>(res);
    expect(saved.revision).toBeGreaterThan(readRevision);

    afterUpdate = await read();
    expect(afterUpdate.markdown.trim()).toBe(SECOND_BODY);
    expect(afterUpdate.revision).toBe(saved.revision);
  });

  it('4 — update again with the OLD revision: 409 PAGE_REVISION_CONFLICT, and GET is unchanged', async () => {
    const res = await updatePageV1(member, pageId, {
      markdown: 'Overwritten from a stale copy.',
      revision: readRevision,
    });
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe('PAGE_REVISION_CONFLICT');

    const now = await read();
    expect(now.markdown).toBe(afterUpdate.markdown);
    expect(now.revision).toBe(afterUpdate.revision);
  });

  it('5 — move under another page, into a folder, then to the root: GET shows each place, body and revision untouched', async () => {
    const moves = [
      [
        { kind: 'page', id: otherPageId },
        { parentPageId: otherPageId, folderId: null },
      ],
      [
        { kind: 'folder', id: folderId },
        { parentPageId: null, folderId },
      ],
      [{ kind: 'root' }, { parentPageId: null, folderId: null }],
    ] as const;
    for (const [parent, placement] of moves) {
      const res = await movePageV1(member, pageId, { parent });
      expect(res.status, parent.kind).toBe(200);
      const now = await read();
      expect(now.placement, parent.kind).toEqual(placement);
      expect(now.markdown).toBe(afterUpdate.markdown);
      expect(now.revision).toBe(afterUpdate.revision);
    }
  });

  it('6 — a caller without page:view on the project and an unknown id get the same not-found, naming nothing', async () => {
    const refused = await getPageV1(outsider, pageId);
    const refusedText = await refused.text();
    const unknown = await getPageV1(member, 'cmzzzzzzzzzzzzzzzzzzzzzzz');
    const unknownText = await unknown.text();

    expect(refused.status).toBe(404);
    expect({ status: unknown.status, body: unknownText }).toEqual({
      status: refused.status,
      body: refusedText,
    });
    expect(JSON.parse(refusedText).code).toBe('PAGE_NOT_FOUND');
    for (const secret of [TITLE, 'Partner sync', 'nightly']) {
      expect(refusedText).not.toContain(secret);
    }
  });

  it('7 — the published OpenAPI document lists the four operations, their schemas and refusals', () => {
    const document = emitOpenApiDocument() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operations = {
      createPage: document.paths['/api/v1/projects/{projectKey}/pages']?.['post'],
      getPage: document.paths['/api/v1/pages/{pageId}']?.['get'],
      updatePage: document.paths['/api/v1/pages/{pageId}']?.['patch'],
      movePage: document.paths['/api/v1/pages/{pageId}/placement']?.['patch'],
    };
    for (const [operationId, operation] of Object.entries(operations)) {
      expect(operation?.['operationId'], operationId).toBe(operationId);
      const responses = operation?.['responses'] as Record<string, unknown>;
      expect(Object.keys(responses), operationId).toContain('404');
      const success = Object.keys(responses).find((status) => status.startsWith('2'));
      expect(JSON.stringify(responses[success!]), operationId).toContain('application/json');
      if (operationId !== 'getPage') {
        expect(operation?.['requestBody'], operationId).toBeDefined();
      }
    }
    for (const operationId of ['updatePage', 'movePage'] as const) {
      expect(Object.keys(operations[operationId]?.['responses'] as object)).toContain('409');
    }
    expect(JSON.stringify(operations.updatePage)).toContain('PAGE_REVISION_CONFLICT');
  });
});
