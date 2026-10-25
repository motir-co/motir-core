import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Which project a `/api/v1` page request is about (Story MOTIR-9486 ·
// MOTIR-9493). A create names the project by KEY in its path; a read, update or
// move names only the PAGE, so its project is looked up from the page id. Both
// go through the services: no route reads a page row itself.

/** The project a key names, inside the token's workspace (browse-gated, 404-not-403). */
export async function resolvePageProject(
  projectKey: string,
  ctx: ServiceContext,
): Promise<{ id: string; identifier: string }> {
  const project = await projectsService.getByKey(projectKey.trim().toUpperCase(), ctx);
  return { id: project.id, identifier: project.identifier };
}

/**
 * The project a page lives in. A missing page and a page the caller may not see
 * are the same `PageNotFoundError` (`pagesService.getPageProjectId`), so the
 * lookup discloses nothing about a page the caller cannot read.
 */
export async function resolvePageProjectId(pageId: string, ctx: ServiceContext): Promise<string> {
  return pagesService.getPageProjectId(ctx, pageId);
}
