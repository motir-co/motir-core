import type { WorkspaceRole } from '@/generated/prisma/client';
import { POST as CREATE_PAGE } from '@/app/api/v1/projects/[projectKey]/pages/route';
import { GET as GET_PAGE, PATCH as PATCH_PAGE } from '@/app/api/v1/pages/[pageId]/route';
import { PATCH as MOVE_PAGE } from '@/app/api/v1/pages/[pageId]/placement/route';
import { POST as ARCHIVE_PAGE } from '@/app/api/v1/pages/[pageId]/archive/route';
import { POST as RESTORE_PAGE } from '@/app/api/v1/pages/[pageId]/restore/route';
import { GET as SEARCH_PAGES } from '@/app/api/v1/projects/[projectKey]/pages/search/route';
import { workspacesService } from '@/lib/services/workspacesService';
import type { TokenGrant } from '@/lib/tokens/grant';
import { withTokenFor, type V1Caller, type V1ProjectCaller } from './apiV1Fixtures';
import { createTestUser } from './userFixtures';

// Shared plumbing for the `/api/v1` PAGE suites (Story MOTIR-9486): the route
// calls, made the way Next.js makes them, and the narrowed callers the refusal
// paths need. The update and move suites add their own route calls here.

export const V1_BASE = 'http://localhost:3000/api/v1';

/** The keys a page caller holds: browse the project, read and write its pages. */
export const PAGE_EDITOR: TokenGrant = ['project:browse', 'page:view', 'page:edit'];

type Headers = { headers: Record<string, string> };

function json(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'content-type': 'application/json' };
}

/** `POST /api/v1/projects/{projectKey}/pages`. */
export function createPageV1(
  caller: Headers,
  projectKey: string,
  body: unknown,
): Promise<Response> {
  return CREATE_PAGE(
    new Request(`${V1_BASE}/projects/${projectKey}/pages`, {
      method: 'POST',
      headers: json(caller.headers),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectKey }) },
  );
}

/** `GET /api/v1/pages/{pageId}`. */
export function getPageV1(caller: Headers, pageId: string): Promise<Response> {
  return GET_PAGE(new Request(`${V1_BASE}/pages/${pageId}`, { headers: caller.headers }), {
    params: Promise.resolve({ pageId }),
  });
}

/** `PATCH /api/v1/pages/{pageId}`. */
export function updatePageV1(caller: Headers, pageId: string, body: unknown): Promise<Response> {
  return PATCH_PAGE(
    new Request(`${V1_BASE}/pages/${pageId}`, {
      method: 'PATCH',
      headers: json(caller.headers),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ pageId }) },
  );
}

/** `PATCH /api/v1/pages/{pageId}/placement`. */
export function movePageV1(caller: Headers, pageId: string, body: unknown): Promise<Response> {
  return MOVE_PAGE(
    new Request(`${V1_BASE}/pages/${pageId}/placement`, {
      method: 'PATCH',
      headers: json(caller.headers),
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ pageId }) },
  );
}

/** `POST /api/v1/pages/{pageId}/archive` — no body. */
export function archivePageV1(caller: Headers, pageId: string): Promise<Response> {
  return ARCHIVE_PAGE(
    new Request(`${V1_BASE}/pages/${pageId}/archive`, { method: 'POST', headers: caller.headers }),
    { params: Promise.resolve({ pageId }) },
  );
}

/** `POST /api/v1/pages/{pageId}/restore` — no body. */
export function restorePageV1(caller: Headers, pageId: string): Promise<Response> {
  return RESTORE_PAGE(
    new Request(`${V1_BASE}/pages/${pageId}/restore`, { method: 'POST', headers: caller.headers }),
    { params: Promise.resolve({ pageId }) },
  );
}

/** `GET /api/v1/projects/{projectKey}/pages/search` — each query parameter set only when given. */
export function searchPagesV1(
  caller: Headers,
  projectKey: string,
  query: { q?: string; cursor?: string },
): Promise<Response> {
  const params = new URLSearchParams();
  if (query.q !== undefined) params.set('q', query.q);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return SEARCH_PAGES(
    new Request(`${V1_BASE}/projects/${projectKey}/pages/search?${params.toString()}`, {
      headers: caller.headers,
    }),
    { params: Promise.resolve({ projectKey }) },
  );
}

/**
 * A second member of the caller's workspace, holding `role`, with a token bound
 * to the caller's project — the person a role-based refusal is about.
 */
export async function memberCaller(
  owner: V1ProjectCaller,
  tag: string,
  role: WorkspaceRole,
  permissions: TokenGrant = PAGE_EDITOR,
): Promise<V1Caller> {
  const user = await createTestUser({ name: `Pages ${tag}` });
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: owner.workspace.id,
    workspaceRole: role,
  });
  return withTokenFor(user, owner.workspace, {
    permissions,
    projectId: owner.fixture.projectId,
  });
}
