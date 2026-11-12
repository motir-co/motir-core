import { NextResponse } from 'next/server';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// GET /api/work-items/planning-anchor?key=<identifier> (MOTIR-4727) — the ANCHOR
// half of a work-item launch of the planning workspace, fetched CLIENT-side.
//
// The workspace is moving from a route to an OVERLAY mounted in the authed shell
// (MOTIR-4725). `app/(planning)/planning/page.tsx` resolved this SERVER-side —
// one `getWorkItemWithAncestors` whose result seeded three things at once: the
// conversation's `anchorId` (MOTIR-909), the pre-filled `@`-mention target
// (MOTIR-1491), and the canvas's arrival trail (MOTIR-2070), so the canvas opens
// on the anchor's OWN level. An overlay is a client island and no client
// component may reach the service layer (CLAUDE.md's 4-layer rule), so the read
// needs an HTTP door.
//
// Built in the exact shape of `app/api/work-items/peek/route.ts` (bug 8.8.2) —
// the data half of the other URL-driven modal: resolve against the actor's
// ACTIVE project, the 2FA hold AFTER the no-project arm, a thin call into the
// service, and the no-existence-leak 404.
//
// Thin HTTP over `workItemsService.getPlanningAnchor` — the SAME view-gated
// lineage read the retiring page and `/roadmap?item=` already make, plus the
// anchor's child count (MOTIR-7621). No `db` / no `$transaction` here.
//
// A stale / deleted / cross-workspace / forbidden key is the same 404 (never a
// 403, which would leak "it exists but you can't see it"). The overlay renders
// that as the project conversation at the root — the page's own silent-catch
// semantics, one hop over the wire.
/**
 * The three ways the read can say "there is nothing here for you" — all one
 * answer, because a 403 on any of them would say "it exists but you can't see
 * it".
 *
 * ⚠️ `ProjectNotFoundError` cannot arise from THIS call, and is kept anyway.
 * `getWorkItemWithAncestors` resolves the ITEM first, so its project exists by
 * the time `assertCanBrowse` reads it — the class is here because this handler
 * is deliberately the peek route's twin, and a leak-sensitive path is the wrong
 * place to narrow a catch on a reading of today's call graph. The invariant it
 * rests on is asserted in `tests/planning/planning-overlay-story-gate.test.ts`.
 */
function isNotAvailable(err: unknown): boolean {
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectAccessDeniedError) return true;
  /* v8 ignore start -- unreachable FROM HERE; see the note above and its named
     test. `resolveInputs` really does raise `ProjectNotFoundError`, for a
     cross-workspace project id — but `getWorkItemWithAncestors` rejects a
     foreign tenant with `WorkItemNotFoundError` BEFORE it reaches
     `assertCanBrowse`, so nothing on this path can get there. Kept because that
     ordering is a fact about another module, not a contract this one owns. */
  return err instanceof ProjectNotFoundError;
  /* v8 ignore stop */
}

export async function GET(req: Request): Promise<Response> {
  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  // The 2FA hold (MOTIR-3653) — placed AFTER the no-project arm, exactly where
  // the peek places it: the no-project answer is its own and must not be
  // reported as a compliance refusal. `ctx.userId` is the session user
  // `getWorkspaceContext` already resolved, so this costs one policy query.
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const key = new URL(req.url).searchParams.get('key')?.trim();
  if (!key) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: '`key` is required.' }, { status: 400 });
  }

  try {
    const { item, ancestors, hasChildren, folders } = await workItemsService.getPlanningAnchor(
      ctx.projectId,
      key,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    // BOTH halves the page composed, raw — the CONSUMER decides the trail. The
    // surface opens INSIDE an anchor that has children and BESIDE one that has
    // none (MOTIR-7621), which is why `hasChildren` rides the body: the kind
    // alone cannot tell a childless story from a broken-down one.
    return NextResponse.json(
      {
        anchor: {
          id: item.id,
          identifier: item.identifier,
          title: item.title,
          kind: item.kind,
        },
        ancestors: ancestors.map((a) => ({
          id: a.id,
          identifier: a.identifier,
          title: a.title,
        })),
        hasChildren,
        // The anchor's placement folder chain, root first (`[]` unfiled): a filed
        // item is drawn behind its folder's door, so the arrival trail walks
        // through these crumbs first, as `/roadmap?item=` does.
        folders,
      },
      {
        // The anchor's title and its ancestors' titles are live item state;
        // never serve a stale chip or a stale breadcrumb.
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  } catch (err) {
    if (isNotAvailable(err)) {
      return NextResponse.json(
        { code: 'NOT_FOUND', error: 'Work item not available.' },
        { status: 404 },
      );
    }
    /* v8 ignore next -- the RE-THROW. Every error this handler can produce from
       the one service call it makes is caught above; anything else is a real
       fault (a dropped connection, a bug) and belongs to Next's error boundary,
       which is what re-throwing gives it. Reaching it in a test would mean
       mocking `workItemsService` — the one thing this story's gate forbids,
       because a mocked service is exactly what stops proving the 404 contract.
       The invariant it rests on is asserted in
       `tests/planning/planning-overlay-story-gate.test.ts`: the catch names the
       three error classes the service throws, and nothing else. */
    /* v8 ignore next -- the RE-THROW, unreachable for the same reason: every
       class this handler's one service call can raise is answered above. Kept
       because a route that swallowed an unexpected fault would turn a bug into a
       404, and Next's error boundary is where a real fault belongs. */
    throw err;
  }
}
