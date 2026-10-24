import type { WorkspaceRole } from '@/generated/prisma/client';
import { POST as CREATE_PAGE } from '@/app/api/v1/projects/[projectKey]/pages/route';
import { GET as GET_PAGE } from '@/app/api/v1/pages/[pageId]/route';
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
