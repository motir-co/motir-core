// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, screen } from '@testing-library/react';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — while a plan is open, its work items cannot leave Planning by
// hand (Story MOTIR-6017 · Subtask MOTIR-6269; `docs/decisions/agent-authored-plans.md`
// AMENDMENT 21). THE DOORS AND THE SEAM.
// ═══════════════════════════════════════════════════════════════════════════
//
// Each code card proved its own side against input it built itself: the doors
// (`tests/planning/planHoldGuard.test.ts`, `tests/api/v1/work-item-transitions-plan-hold
// .test.ts`) assert a payload, the status control (`tests/components/status-held-notice
// .test.tsx`, `use-status-held.test.tsx`) renders a hand-built `PlanHoldDTO`. This file
// stands at the JOIN, against a REAL Postgres:
//
//   1. ONE REFUSAL PER DOOR. One held card, the four doors, and the SAME `planId`,
//      `planStatus`, `sessionId` and `anchorKey` from each (MCP carries what its text
//      channel carries — see its test).
//   2. THE WRITER → CONSUMER SEAM. Each door's REAL payload goes through the REAL
//      client helpers (`readHeldRefusal`, `useStatusHeld`'s plan fold) into the
//      shipped `StatusHeldNotice`, and the Review plan door it draws must equal
//      `planRowDestination`'s href for the plan's facts READ FROM THE DATABASE —
//      never from the payload, which is the side a key drift would corrupt.
//   3. A SESSION-ONLY PARK moves by hand on every door.
//   4. CROSS-TENANT: a lock row in workspace A never holds, or leaks into the
//      refusal of, a card in workspace B.
//
// ⚠️ happy-dom + REAL POSTGRES in one file, deliberately — the seam ends at a
// screen (`tests/integration/plans/planHistoryStoryGate.test.tsx` is the precedent).
// Stubbed: the session and active-project resolvers (the project rule), and the
// router hooks the notice reads its host from (there is no router in a unit render).
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
const HOST = '/items/PROD-1';
vi.mock('next/navigation', () => ({
  usePathname: () => HOST,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { planTargetHeldSchema } from '@/lib/api/v1/workItems/schema';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { planRowDestination } from '@/lib/planning/planDestination';
import type { PlanHeldByPlanDTO, PlanHoldDTO } from '@/lib/dto/plans';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { runTransitionStatus } from '@/lib/mcp/tools/transitionStatus';
import { changeStatusAction } from '@/app/(authed)/items/[key]/edit/actions';
import { POST as movePOST } from '@/app/api/board/move/route';
import { readHeldRefusal } from '@/components/issues/heldRefusal';
import { useStatusHeld } from '@/components/issues/useStatusHeld';
import { StatusHeldNotice } from '@/components/issues/StatusHeldNotice';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';

const T = { timeout: 60_000 };

let caller: V1ProjectCaller;
let fx: WorkItemFixture;

function actAs(f: WorkItemFixture) {
  session.current = { user: { id: f.ownerId, email: f.owner.email, name: 'Owner' } };
  activeCtx.current = {
    userId: f.ownerId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  resetRateLimitStore();
  caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  fx = caller.fixture;
  actAs(fx);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Seeding ──────────────────────────────────────────────────────────────────

type Card = { id: string; identifier: string };

async function seedCard(f: WorkItemFixture = fx, title = 'The card'): Promise<Card> {
  const dto = await workItemsService.createWorkItem(
    { projectId: f.projectId, kind: 'task', title },
    f.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

/** A `planned` plan with one `modify` naming `card`, which PARKS it at `planning`.
 *  Its session is anchored at `anchor` (the To-approve row's `targetKeys[0]`). */
async function heldBy(
  card: Card,
  opts: { f?: WorkItemFixture; anchor?: string | null; withSession?: boolean } = {},
): Promise<string> {
  const f = opts.f ?? fx;
  const plan = await plansService.createPlan(f.projectId, { title: 'Re-plan' }, f.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: card.id, patch: { descriptionMd: 'Re-scoped.' } }],
    f.ctx,
  );
  await plansService.markPlanned(plan.id, f.ctx);
  const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
  if (row.sessionId && opts.anchor !== undefined) {
    await adminDb.planChangeSession.update({
      where: { id: row.sessionId },
      data: { targetKeys: opts.anchor === null ? [] : [opts.anchor, 'OTHER-9'] },
    });
  }
  // The rollout residue `planRowDestination` names: a plan with NO session.
  if (opts.withSession === false) {
    await adminDb.plan.update({ where: { id: plan.id }, data: { sessionId: null } });
  }
  return plan.id;
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/** The plan's facts as the DATABASE holds them — the independent side of the seam. */
async function planFacts(planId: string) {
  const plan = await adminDb.plan.findUniqueOrThrow({
    where: { id: planId },
    include: { session: { select: { targetKeys: true } } },
  });
  return {
    planId,
    planStatus: plan.status as PlanHeldByPlanDTO['planStatus'],
    sessionId: plan.sessionId,
    anchorKey: plan.session?.targetKeys[0] ?? null,
  };
}

async function boardColumns(f: WorkItemFixture = fx) {
  const statuses = await workflowsService.listStatusesByProject(f.projectId, f.workspaceId);
  const board = await adminDb.board.create({
    data: {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      name: 'Board',
      type: 'kanban',
      position: 'a0',
    },
  });
  const columns: Record<string, string> = {};
  for (const [n, status] of statuses.entries()) {
    const column = await adminDb.boardColumn.create({
      data: {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        boardId: board.id,
        name: status.label,
        position: `c${n.toString(36)}`,
      },
    });
    await adminDb.boardColumnStatus.create({
      data: {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        boardId: board.id,
        columnId: column.id,
        statusId: status.id,
      },
    });
    columns[status.key] = column.id;
  }
  return { boardId: board.id, columns, statuses };
}

// ── The four doors ───────────────────────────────────────────────────────────

function boardMove(boardId: string, workItemId: string, toColumnId: string) {
  return movePOST(
    new Request('http://localhost:3000/api/board/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boardId, workItemId, toColumnId }),
    }),
  );
}

type Handler = (
  req: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function v1Transition(key: string, status: string): Promise<Response> {
  const mod = (await import('@/app/api/v1/work-items/[key]/transitions/route')) as unknown as {
    POST: Handler;
  };
  return mod.POST(
    new Request(`http://localhost:3000/api/v1/work-items/${key}/transitions`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ key }) },
  );
}

/** The four fields AMENDMENT 21 §2 says a door's destination is computed from. */
const FOUR = (p: PlanHoldDTO) => ({
  planId: p.planId,
  planStatus: p.planStatus,
  sessionId: p.sessionId,
  anchorKey: p.anchorKey,
});

/** What the MCP text channel says about the plan state (`planHeldResult`). */
const MCP_STATE: Record<PlanHeldByPlanDTO['planStatus'], string> = {
  generating: 'is still being written',
  planned: 'is waiting for approval',
  approving: 'is being approved — its approval releases this card when it finishes',
  stale: 'is stale and needs attention before it can be approved',
};

/** Render the shipped notice for a plan and return the Review plan door's href. */
function doorHref(plan: PlanHoldDTO): string {
  renderWithIntl(<StatusHeldNotice itemKey={plan.itemKey} lines={[]} plan={plan} />);
  const door = screen.getByRole('link', { name: 'Review plan' });
  const href = door.getAttribute('href')!;
  cleanup();
  return href;
}

describe('one refusal per door — the same four fields for one held card', () => {
  it.each([
    ['a plan WITH a session, anchored', { anchor: 'ANCHOR-1' as string | null, withSession: true }],
    ['a plan WITH a session, project-wide (no anchor)', { anchor: null, withSession: true }],
    ['a plan with NO session (the rollout residue)', { withSession: false }],
  ])('%s', T, async (_label, shape) => {
    const card = await seedCard();
    const planId = await heldBy(card, shape);
    const facts = await planFacts(planId);
    const expected = { ...facts };
    const { boardId, columns } = await boardColumns();

    // Board — 409 `PLAN_TARGET_HELD` with `plan`.
    const boardRes = await boardMove(boardId, card.id, columns.in_progress!);
    expect(boardRes.status).toBe(409);
    const boardBody = (await boardRes.clone().json()) as { code: string; plan: PlanHoldDTO };
    expect(boardBody.code).toBe('PLAN_TARGET_HELD');

    // v1 — 422 `PLAN_TARGET_HELD`, parsed by the published response schema.
    const v1Res = await v1Transition(card.identifier, 'in_progress');
    expect(v1Res.status).toBe(422);
    const v1Body = planTargetHeldSchema.parse(await v1Res.json());
    expect(v1Body.code).toBe('PLAN_TARGET_HELD');

    // The edit server action (the item page, quick view, inline edit, edit form).
    const action = await changeStatusAction({ id: card.id, toStatusKey: 'in_progress' });
    expect(action).toMatchObject({ ok: false, field: 'status', code: 'PLAN_TARGET_HELD' });
    const actionPlan = (action as { plan: PlanHoldDTO }).plan;

    // MCP — a tool error carrying the code, the plan id and its state.
    const mcp = await runTransitionStatus({ key: card.identifier, status: 'in_progress' }, fx.ctx);
    expect(mcp.isError).toBe(true);
    const mcpText = (mcp.content as Array<{ text: string }>)[0]!.text;

    // ⭐ THE SAME FOUR FIELDS, from every door that carries a payload…
    expect(FOUR(boardBody.plan)).toEqual(expected);
    expect(FOUR(v1Body.plan as PlanHoldDTO)).toEqual(expected);
    expect(FOUR(actionPlan)).toEqual(expected);
    // …and all three name the held card.
    for (const p of [boardBody.plan, v1Body.plan as PlanHoldDTO, actionPlan]) {
      expect(p).toMatchObject({ itemKey: card.identifier, workItemId: card.id });
    }
    // MCP's result is TEXT (`toolError` has no structured channel): it carries
    // the code, the `planId` and the `planStatus` sentence. It does NOT carry
    // `sessionId` / `anchorKey` — an agent has no Review plan door to draw, and
    // reads the plan by id (`get_plan`). Pinned as-is so a change is deliberate.
    expect(mcpText.startsWith('PLAN_TARGET_HELD: ')).toBe(true);
    expect(mcpText).toContain(`Plan ${facts.planId} ${MCP_STATE[facts.planStatus]}.`);

    // Nothing moved on any door.
    expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
  });
});

describe('the writer → consumer seam — every door’s payload opens where the plan is', () => {
  const statuses = (): Promise<WorkflowStatusDto[]> =>
    workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);

  type Shape = { anchor?: string | null; withSession?: boolean };
  it.each<[string, Shape]>([
    ['with a session, anchored → the planning surface', { anchor: 'ANCHOR-1' }],
    ['with a session, project-wide → the planning surface', { anchor: null }],
    ['with no session → the plan page', { withSession: false }],
  ])('a plan %s', T, async (_label, shape) => {
    const card = await seedCard();
    const planId = await heldBy(card, shape);
    const facts = await planFacts(planId);
    // THE INDEPENDENT SIDE: the rule, fed the DATABASE's facts.
    const want = planRowDestination({ ...facts, host: HOST });
    expect(want.kind).toBe(shape.withSession === false ? 'plan-page' : 'planning-surface');

    const hrefs: Record<string, string> = {};

    // 1 · The board door → `readHeldRefusal` (the board's and the list's reader).
    const { boardId, columns } = await boardColumns();
    const refusal = await readHeldRefusal(await boardMove(boardId, card.id, columns.in_progress!));
    expect(refusal?.code).toBe('PLAN_TARGET_HELD');
    hrefs.board = doorHref((refusal as { plan: PlanHoldDTO }).plan);

    // 2 · The status action → `useStatusHeld`'s refusal fold (`onPlanHeldRefused`),
    //     exactly as the item page / quick view / edit form wire it.
    const action = await changeStatusAction({ id: card.id, toStatusKey: 'in_progress' });
    const folded = renderHook(() => useStatusHeld(undefined, [], PLANNING_STATUS_KEY, null));
    act(() => folded.result.current.onPlanHeldRefused((action as { plan: PlanHoldDTO }).plan));
    expect(folded.result.current.plan).not.toBeNull();
    hrefs.action = doorHref(folded.result.current.plan!);
    folded.unmount();

    // 3 · The v1 door's `plan` — the same DTO a REST client would draw from.
    const v1 = planTargetHeldSchema.parse(
      await (await v1Transition(card.identifier, 'todo')).json(),
    );
    hrefs.v1 = doorHref(v1.plan as PlanHoldDTO);

    // 4 · The UP-FRONT read → `useStatusHeld`'s SEED, the page's own path.
    const seed = await planTargetLockService.readPlanHold(card.id, fx.ctx);
    const up = renderHook(() => useStatusHeld(undefined, [], PLANNING_STATUS_KEY, seed));
    hrefs.upFront = doorHref(up.result.current.plan!);
    up.unmount();

    // ⭐ Every consumer's door is the rule's door.
    expect(hrefs).toEqual({
      board: want.href,
      action: want.href,
      v1: want.href,
      upFront: want.href,
    });
    // …and the plan door never borrows the approval overlay's address (§11.5b).
    expect(want.href).not.toMatch(/[?&]approval=/);
  });

  it(
    'the fold locks every other option — the picker’s held list comes from the same payload',
    T,
    async () => {
      const card = await seedCard();
      await heldBy(card, { anchor: card.identifier });
      const action = await changeStatusAction({ id: card.id, toStatusKey: 'todo' });
      const all = await statuses();
      const { result } = renderHook(() => useStatusHeld(undefined, all, PLANNING_STATUS_KEY, null));
      act(() => result.current.onPlanHeldRefused((action as { plan: PlanHoldDTO }).plan));
      expect(result.current.held.map((h) => h.statusKey).sort()).toEqual(
        all
          .map((s) => s.key)
          .filter((k) => k !== PLANNING_STATUS_KEY)
          .sort(),
      );
      expect(new Set(result.current.held.map((h) => h.waitingOn))).toEqual(new Set(['plan']));
    },
  );
});

describe('a SESSION-only park (no plan) is held while the session is open (AMENDMENT 23 §5)', () => {
  /** A card at `planning` under a lock whose `planId` is NULL — a conversation's
   *  lease, which holds the card while that session is OPEN. */
  async function sessionParked(title: string): Promise<{ card: Card; sessionId: string }> {
    const card = await seedCard(fx, title);
    const planId = await heldBy(card);
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    await adminDb.planTargetLock.update({
      where: { workItemId: card.id },
      data: { planId: null, sessionId: plan.sessionId },
    });
    expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toMatchObject({
      kind: 'session',
      sessionId: plan.sessionId,
    });
    return { card, sessionId: plan.sessionId! };
  }

  it('the board, v1, the status action and MCP all refuse it, naming the session', T, async () => {
    const { boardId, columns } = await boardColumns();
    const { card, sessionId } = await sessionParked('Held');

    const boardRes = await boardMove(boardId, card.id, columns.in_progress!);
    expect(boardRes.status).toBe(409);
    const boardBody = (await boardRes.json()) as { code: string; plan: PlanHoldDTO };
    expect(boardBody.code).toBe('PLAN_TARGET_HELD');
    expect(boardBody.plan).toMatchObject({ kind: 'session', sessionId, planId: null });

    const v1Res = await v1Transition(card.identifier, 'in_progress');
    expect(v1Res.status).toBe(422);
    const v1Body = planTargetHeldSchema.parse(await v1Res.json());
    expect(v1Body.plan).toMatchObject({ kind: 'session', sessionId });

    const action = await changeStatusAction({ id: card.id, toStatusKey: 'in_progress' });
    expect(action).toMatchObject({ ok: false, field: 'status', code: 'PLAN_TARGET_HELD' });

    const mcp = await runTransitionStatus({ key: card.identifier, status: 'in_progress' }, fx.ctx);
    expect(mcp.isError).toBe(true);
    expect((mcp.content as Array<{ text: string }>)[0]!.text.startsWith('PLAN_TARGET_HELD: ')).toBe(
      true,
    );

    expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('once the session ENDS, every door moves it by hand', T, async () => {
    const { boardId, columns } = await boardColumns();
    const parked: Array<{ card: Card; sessionId: string }> = [];
    for (const title of ['Board', 'V1', 'Action', 'MCP']) parked.push(await sessionParked(title));
    await adminDb.planChangeSession.updateMany({
      where: { id: { in: parked.map((p) => p.sessionId) } },
      data: { endedAt: new Date(), endReason: 'idle' },
    });
    const [a, b, c, d] = parked.map((p) => p.card) as [Card, Card, Card, Card];

    expect((await boardMove(boardId, a.id, columns.in_progress!)).status).toBe(200);
    expect(await statusOf(a.id)).toBe('in_progress');

    expect((await v1Transition(b.identifier, 'in_progress')).status).toBe(200);
    expect(await statusOf(b.id)).toBe('in_progress');

    expect((await changeStatusAction({ id: c.id, toStatusKey: 'in_progress' })).ok).toBe(true);
    expect(await statusOf(c.id)).toBe('in_progress');

    const mcp = await runTransitionStatus({ key: d.identifier, status: 'in_progress' }, fx.ctx);
    expect(mcp.isError).toBeFalsy();
    expect(await statusOf(d.id)).toBe('in_progress');
  });
});

describe('cross-tenant isolation', () => {
  it(
    'a card held in workspace A is neither held for, nor leaks its plan to, workspace B',
    T,
    async () => {
      const held = await seedCard();
      const planId = await heldBy(held, { anchor: held.identifier });
      const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });

      // B's up-front read of A's card: not held — and not an error that names it.
      expect(await planTargetLockService.readPlanHold(held.id, other.ctx)).toBeNull();

      // B's hand move of A's card is refused as NOT FOUND, never as A's plan hold.
      actAs(other);
      const action = await changeStatusAction({ id: held.id, toStatusKey: 'in_progress' });
      expect(action.ok).toBe(false);
      expect(action).not.toHaveProperty('code', 'PLAN_TARGET_HELD');
      expect(JSON.stringify(action)).not.toContain(planId);
      const mcp = await runTransitionStatus(
        { key: held.identifier, status: 'in_progress' },
        other.ctx,
      );
      expect(JSON.stringify(mcp.content)).not.toContain(planId);
      expect(await statusOf(held.id)).toBe(PLANNING_STATUS_KEY);
    },
  );

  it('a lock row written in workspace A never holds a card in workspace B', T, async () => {
    // A: a live `planned` plan (its own card parked under it).
    const aCard = await seedCard(fx, 'A card');
    const aPlanId = await heldBy(aCard);

    // B: a card hand-parked at Planning with no plan of its own…
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const bCard = await seedCard(other, 'B card');
    await workItemsService.updateStatus(bCard.id, PLANNING_STATUS_KEY, other.ctx);
    // …and a FORGED lock row: A's workspace, A's project, A's undecided plan, naming
    // B's card. Written as the admin role — no product path can write it.
    await adminDb.planTargetLock.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: bCard.id,
        planId: aPlanId,
        priorStatus: 'todo',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    // B's read does not see it, and B's hand move is an ordinary move.
    expect(await planTargetLockService.readPlanHold(bCard.id, other.ctx)).toBeNull();
    actAs(other);
    const moved = await changeStatusAction({ id: bCard.id, toStatusKey: 'in_progress' });
    expect(moved.ok).toBe(true);
    expect(await statusOf(bCard.id)).toBe('in_progress');
  });
});
