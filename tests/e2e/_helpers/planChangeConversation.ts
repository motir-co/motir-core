import { plansService } from '@/lib/services/plansService';
import { adminDb } from './db-reset';
import { markEveryAddWritten } from '../../helpers/walkWritten';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { buildScope, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * Run a seed's plan APPEND as a turn of its CONVERSATION, then put the
 * conversation back as the browser will find it (bug MOTIR-5640).
 *
 * ⚠️ WHY THE E2E SEEDS OWE THIS. A real submit does two things: it opens the
 * Plan bound to the job, AND it stamps that job onto the plan-change SESSION as
 * its `lastJobId` (`planChangeSessionsService.submit`). The seeds stood in for
 * the handler and did only the first, so the plans they produced belonged to no
 * conversation. Once a plan PARKS its targets, a card is planned by one planner
 * at a time — and a session-less seeded plan read as a SECOND planner: two turns
 * over one card were refused with `PlanTargetLockedError`, and a contextual seed
 * fought the browser's own session-open on its anchor.
 *
 * ⚠️ AND WHY THE LINK IS ONLY FOR THE APPEND — found by the merge queue, the
 * second time. The first version of this helper LEFT `lastJobId` pointing at the
 * seeded job. But the specs seed the plan BEFORE the user types, as a stand-in
 * for what the handler will produce after the (stubbed) submit — and a session
 * whose `lastJobId` already names a `planned` plan is, to the rail, a FINISHED
 * turn awaiting review. So the rail resumed it on mount and showed the confirm
 * bar before any turn was sent: `cloud-contextual-plan-confirm.spec.ts`'s
 * failed-run case saw a gate it should never have had, and the cases that EXPECT
 * a gate could pass without their turn ever running.
 *
 * So the conversation is linked for exactly as long as the append needs to
 * resolve its plan to it (a conversation's plan parks nothing — its session is
 * the holder), and `lastJobId` is then restored to what it was: at page load, no
 * turn has been submitted. A session row that did not exist before is KEPT, with
 * `lastJobId` null — the same row the rail's own open would create, which it
 * then resumes rather than forking.
 *
 * ⚠️ AND IT IS BOUND. `db` is RLS-scoped: an unbound read finds nothing and an
 * unbound write is refused, so every tenant statement runs inside
 * `withWorkspaceServiceContext`.
 */
export async function asConversationTurn<T>(
  ctx: ServiceContext,
  projectId: string,
  /** The anchor: a work-item ID when `anchorIsWorkItemId`, else a raw scope key.
   *  `null` means the project-wide thread. */
  anchor: string | null,
  jobId: string,
  append: (sessionId: string) => Promise<T>,
  opts: { anchorIsWorkItemId?: boolean } = {},
): Promise<T> {
  const { sessionId, previousLastJobId } = await withWorkspaceServiceContext(
    ctx.workspaceId,
    async (tx) => {
      let scopeKey = PROJECT_SCOPE_KEY;
      if (anchor !== null) {
        if (opts.anchorIsWorkItemId) {
          // The scope key is built from the anchor's `MOTIR-<n>` KEY — what
          // `buildScope` canonicalizes and the contextual route persists.
          const item = await tx.workItem.findUniqueOrThrow({ where: { id: anchor } });
          scopeKey = buildScope([item.identifier]).scopeKey;
        } else {
          scopeKey = anchor;
        }
      }
      const existing = await tx.planChangeSession.findFirst({ where: { projectId, scopeKey } });
      if (existing) {
        await tx.planChangeSession.update({
          where: { id: existing.id },
          data: { lastJobId: jobId },
        });
        return { sessionId: existing.id, previousLastJobId: existing.lastJobId };
      }
      const created = await tx.planChangeSession.create({
        data: { workspaceId: ctx.workspaceId, projectId, scopeKey, lastJobId: jobId },
      });
      return { sessionId: created.id, previousLastJobId: null };
    },
  );

  try {
    return await append(sessionId);
  } finally {
    // Back to the state the BROWSER finds: no turn submitted yet.
    await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      tx.planChangeSession.update({
        where: { id: sessionId },
        data: { lastJobId: previousLastJobId },
      }),
    );
  }
}

// ── Session TIME, set rather than waited (Story MOTIR-6011 · MOTIR-6027) ─────
//
// ⚠️ There is no resume WINDOW any more (AMENDMENT 23 §3, Story MOTIR-7630): an
// open session is resumed at any age, and only an END stops a resume. What a
// session's `lastActivityAt` still decides is the IDLE CLOSE — the lock sweep
// ends an open session idle past the 30-minute lease — so a spec that needs "a
// conversation left alone" moves that column back (`adminDb`) rather than
// waiting real time.

/** The member's most recently active planning conversation in the project. */
export async function latestPlanningSession(
  email: string,
): Promise<{ id: string; workspaceId: string; createdById: string }> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });
  const session = await adminDb.planChangeSession.findFirstOrThrow({
    where: { createdById: user.id },
    orderBy: { lastActivityAt: 'desc' },
  });
  return { id: session.id, workspaceId: session.workspaceId, createdById: user.id };
}

/**
 * Let the conversation's run FINISH: its latest plan gains one proposal and
 * closes as `planned` — what the planner's handler does when a real job
 * completes (`addProposals` → `markPlanned`, the same shipped services). The lane's
 * motir-ai mock settles a plan job with nothing proposed, so without this the
 * plan would stay `generating` for ever.
 */
export async function finishSessionPlan(sessionId: string, title: string): Promise<string> {
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
  });
  const session = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
  const ctx = { userId: session.createdById!, workspaceId: session.workspaceId };
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title, kind: 'task' } }],
    ctx,
  );
  await markEveryAddWritten(plan.id);
  await plansService.markPlanned(plan.id, ctx);
  return plan.id;
}

/**
 * Finish a session's run with a plan of SEVERAL cards under one parent, ONE OF
 * THEM BLOCKED BY ANOTHER — the shape MOTIR-6188's walk needs and the one
 * {@link finishSessionPlan} deliberately does not produce.
 *
 * `finishSessionPlan` appends a single `task` with no edges, which is all its
 * callers ever wanted: they are about the gate, not about what the canvas draws.
 * This story is about what the canvas draws, so it needs a PENDING `blocked_by`
 * — the dashed arrow between two proposed cards is the thing the surface and the
 * plan page have to agree on.
 *
 * ⚠️ TWO `addProposals` CALLS, and that is the contract rather than a style
 * choice: a `planItem:` ref resolves only against proposals the plan ALREADY
 * HOLDS, so the blocked card cannot travel in the same batch as its blocker.
 *
 * Returns the plan id and the proposed titles in append order — the blocker
 * first, so a caller can name the arrow's two ends without re-reading the plan.
 */
export async function finishSessionPlanWithEdge(
  sessionId: string,
  parentWorkItemId: string,
  titles: [string, string, string],
): Promise<{ planId: string; blockerTitle: string; blockedTitle: string }> {
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
  });
  const session = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
  const ctx: ServiceContext = { userId: session.createdById!, workspaceId: session.workspaceId };

  const first = await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: titles[0], kind: 'subtask' },
        parentRef: parentWorkItemId,
      },
      {
        op: 'add',
        proposedFields: { title: titles[2], kind: 'subtask' },
        parentRef: parentWorkItemId,
      },
    ],
    ctx,
  );

  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: titles[1], kind: 'subtask' },
        parentRef: parentWorkItemId,
        blockedByRefs: [`planItem:${first.appendedItemIds[0]}`],
      },
    ],
    ctx,
  );

  await markEveryAddWritten(plan.id);
  await plansService.markPlanned(plan.id, ctx);
  return { planId: plan.id, blockerTitle: titles[0], blockedTitle: titles[1] };
}

/**
 * Finish a session's run with a plan of `titles.length` cards under one parent and
 * no edges between them — the shape a spec about the LIST's GEOMETRY needs, where
 * what matters is how many rows there are, not what the canvas draws between them
 * (MOTIR-7726). One `addProposals` call, since nothing here refers to anything
 * else in the batch.
 */
export async function finishSessionPlanWithCards(
  sessionId: string,
  parentWorkItemId: string,
  titles: readonly string[],
): Promise<string> {
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
  });
  const session = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
  const ctx: ServiceContext = { userId: session.createdById!, workspaceId: session.workspaceId };
  await plansService.addProposals(
    plan.id,
    titles.map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'subtask' as const },
      parentRef: parentWorkItemId,
    })),
    ctx,
  );
  await markEveryAddWritten(plan.id);
  await plansService.markPlanned(plan.id, ctx);
  return plan.id;
}
