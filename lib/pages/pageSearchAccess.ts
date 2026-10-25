import type { Prisma } from '@/generated/prisma/client';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE access filter of page search (Story MOTIR-9489 · MOTIR-9551). Every
// search over a project's pages — the full-text read now, the by-meaning read
// that merges into it later — calls this FIRST, before it looks at the query or
// the cursor, and reads only inside the scope it returns: the live pages of that
// one project (`PAGE_SEARCH_LIVE_IN_PROJECT` in `pageRepository`). A search door
// never writes a second check of its own.
//
// A caller without `page:view` is refused with `assertCanViewPages`'s named
// refusal (`ProjectAccessDeniedError`: 'browse' for a non-member, 'edit' for a
// member without the permission) before any page is read, so a refusal, a hit,
// a snippet or a count never discloses a title.

/** The scope a page search may read once {@link authorizePageSearch} has passed. */
export interface PageSearchScope {
  readonly projectId: string;
}

export async function authorizePageSearch(
  ctx: ServiceContext,
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<PageSearchScope> {
  await projectAccessService.assertCanViewPages(projectId, ctx, tx);
  return { projectId };
}
