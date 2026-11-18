import { beforeEach, describe, expect, it, vi } from 'vitest';

// motir-ai is the only thing stubbed — it is what mints the job id the plan and
// the conversation both bind to. Every route, service, Plan row, session row and
// response below is real, against real Postgres.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(),
  getJob: vi.fn(),
}));

import {
  GET as READ_PLAN,
  POST as APPROVE,
} from '@/app/api/v1/work-items/[key]/plan-approval/route';
import { POST as SESSION_SUBMIT } from '@/app/api/v1/projects/[projectKey]/plan-session/submissions/route';
import { POST as SESSION_TURN } from '@/app/api/v1/projects/[projectKey]/plan-session/turns/route';
import { submitJob } from '@/lib/ai/motirAiClient';
import { DOMAIN_ERROR_STATUS } from '@/lib/api/v1/errors';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import { planSchema, workItemPlanSchema, type V1Plan } from '@/lib/api/v1/workLoop/schema';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { plansService } from '@/lib/services/plansService';
import { planDecisionService } from '@/lib/services/planDecisionService';
import { PlanRevisionInFlightError } from '@/lib/plans/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  createV1ProjectCaller,
  withTokenFor,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/work-items/{key}/plan-approval (MOTIR-3021 / MOTIR-3023) — the
// bounded public entrance `motir auto --auto-approve-replan` drives, against
// real Postgres. `docs/decisions/run-findings-protocol.md` Q2 is its spec.
//
// This endpoint reverses a deliberate absence, so the tests that matter are the
// ones about what it REFUSES:
//
//   • THE ANCHOR (B1), and it is STRUCTURAL here rather than checked: the route
//     takes no plan id at all, so a caller cannot name a plan the card did not
//     produce. Every other plan — a cadence plan, an onboarding generation, one
//     submitted from the project-wide panel — keeps the human decision it was
//     written under, because none of them is reachable from a card's key.
//   • NO SECOND IMPLEMENTATION. The one-shot guard, the confirmation gate and
//     the `ai:decide_plan` assertion are the shipped service's; a 409 on a second
//     approve is the SAME 409 the in-app route answers.
//   • NO EXISTENCE LEAK. Another tenant's plan and an invented id are one answer.
//   • A DISPATCHED AGENT CANNOT REACH IT. `CLI_TOKEN_GRANT` omits the key, and
//     that is asserted here rather than left as a property of a constant nobody
//     reads next to this route.

const BASE = 'http://localhost:3000/api/v1';

/**
 * The permission set an OPERATOR driving `motir auto` holds.
 *
 * ⚠️ `ai:decide_plan` SINCE MOTIR-3188, and the change is the whole point of
 * that card. This read `ai:view_plan`, which gated no view and held two
 * authorities at once — authoring a plan and DECIDING one. Approval moved to the
 * decide half, so the operator needs it here; `ai:view_plan` stays in the set
 * because the same operator's agent AUTHORS the plan this route then approves,
 * and dropping it would test a narrower actor than the real one.
 */
const OPERATOR = [
  'project:browse',
  'work_item:edit',
  'ai:plan',
  'ai:view_plan',
  'ai:decide_plan',
] as const;

function approve(caller: V1ProjectCaller, key: string): Promise<Response> {
  return APPROVE(
    new Request(`${BASE}/work-items/${key}/plan-approval`, {
      method: 'POST',
      headers: caller.headers,
    }),
    { params: Promise.resolve({ key }) },
  );
}

function readPlan(caller: V1ProjectCaller, key: string): Promise<Response> {
  return READ_PLAN(
    new Request(`${BASE}/work-items/${key}/plan-approval`, { headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
}

async function makeItem(caller: V1ProjectCaller, title: string) {
  return workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'story', title },
    caller.ctx,
  );
}

function sessionReq(caller: V1ProjectCaller, suffix: string, body: unknown): Request {
  return new Request(`${BASE}/projects/${caller.projectKey}/plan-session${suffix}`, {
    method: 'POST',
    headers: { ...caller.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Build the exact shape a refused run leaves behind: an ANCHORED plan-change
 * conversation about one card, submitted, with a `planned` plan carrying one
 * proposal.
 *
 * Driven through the REAL submit path rather than by writing rows, because the
 * anchor this endpoint checks is DERIVED — `plan.sourceJobId` → the session
 * whose `lastJobId` is that job → its `targetKeys` — and a hand-built fixture
 * could satisfy the check while the real path did not produce it.
 */
async function refusedCardWithPlan(
  caller: V1ProjectCaller,
  opts: { jobId?: string; anchored?: boolean; close?: boolean } = {},
): Promise<{ key: string; planId: string }> {
  const item = await makeItem(caller, 'the card the agent refused');
  const jobId = opts.jobId ?? `job_${item.identifier}`;
  vi.mocked(submitJob).mockResolvedValue({ jobId } as Awaited<ReturnType<typeof submitJob>>);

  const args = { params: Promise.resolve({ projectKey: caller.projectKey }) };
  const targetKeys = opts.anchored === false ? [] : [item.identifier];
  await SESSION_TURN(
    sessionReq(caller, '/turns', { body: 'its premise is false', targetKeys }),
    args,
  );
  const submitted = await SESSION_SUBMIT(sessionReq(caller, '/submissions', { targetKeys }), args);
  expect(submitted.status).toBe(202);
  const { planId } = (await submitted.json()) as { planId: string };

  // The proposals a planner would have appended, then closed into `planned`.
  await plansService.addProposals(
    planId,
    // A `task`, not a `subtask`: the confirmation gate applies the same
    // kind-parent matrix a human create is gated on, and a parentless subtask is
    // refused by it — correctly, and not what these tests are about.
    [{ op: 'add', proposedFields: { title: 'the corrected card', kind: 'task' } }],
    caller.ctx,
  );
  // `close: false` leaves the plan `generating` — the state a run actually meets,
  // because the agent submits with `--detach` and the planner is still writing.
  if (opts.close !== false) await plansService.markPlanned(planId, caller.ctx);
  return { key: item.identifier, planId };
}

describe('POST /api/v1/work-items/{key}/plan-approval', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('approves the plan the card produced, and materializes its proposals', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);

    const res = await approve(caller, key);

    expect(res.status).toBe(200);
    const body = (await res.json()) as V1Plan;
    expect(() => planSchema.parse(body)).not.toThrow();
    expect(body.status).toBe('approved');
    // The proposal became a row — asserted through the payload, which is what a
    // client reads, rather than by counting the table behind it.
    expect(body.proposals[0]?.workItemKey).not.toBeNull();
    // And the plan's own id comes back, which is how a caller that never knew it
    // reports WHAT it approved.
    expect(body.id).toBeTruthy();
  });

  it('accepts the key case-insensitively — a caller types either', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);

    expect((await approve(caller, key.toLowerCase())).status).toBe(200);
  });

  // ── B1, the bound ─────────────────────────────────────────────────────────

  it('REFUSES a card with no plan of its own, and says why', async () => {
    // The card exists and the caller may edit it; there is simply no plan its
    // own refusal produced. A DIFFERENT card's plan is not reachable from here
    // at all — the route takes no plan id — which is what makes this bound
    // structural rather than a check.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    await refusedCardWithPlan(caller);
    const other = await makeItem(caller, 'a different card entirely');

    const res = await approve(caller, other.identifier);

    expect(res.status).toBe(DOMAIN_ERROR_STATUS['NO_PLAN_FOR_WORK_ITEM']);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('NO_PLAN_FOR_WORK_ITEM');
    // Actionable, not a bare refusal: it names the card and where to go instead.
    expect(body.error).toContain(other.identifier);
    expect(body.error).toContain('approve any other plan in Motir');
  });

  it('REFUSES when the plan came from the PROJECT-WIDE thread — unanchored is not unrestricted', async () => {
    // The case the bound most protects: a project-wide plan is the shape a
    // cadence plan and an onboarding generation both have. Treating "no anchor"
    // as "no restriction" would invert the bound at exactly the plans a person
    // is most expected to decide on.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller, { anchored: false });

    const res = await approve(caller, key);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('NO_PLAN_FOR_WORK_ITEM');
    // And nothing was approved: the plan is where it was.
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('planned');
  });

  it('REFUSES a card whose conversation exists but has never submitted', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const item = await makeItem(caller, 'talked about, never submitted');
    await SESSION_TURN(
      sessionReq(caller, '/turns', { body: 'thinking about it', targetKeys: [item.identifier] }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );

    const res = await approve(caller, item.identifier);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('NO_PLAN_FOR_WORK_ITEM');
  });

  // ── B2 / B3, inherited from the service ───────────────────────────────────

  it('answers 409 on a SECOND approve — the same one-shot guard the app hits', async () => {
    // Mirrored, not softened into a no-op. Two entrances answering one condition
    // two ways is what "no second approval implementation" exists to prevent.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);

    expect((await approve(caller, key)).status).toBe(200);
    const second = await approve(caller, key);

    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('PLAN_NOT_IN_EXPECTED_STATUS');
  });

  it('carries the plan STATUS on the 409 — the field a loop branches on', async () => {
    // ⚠️ THE REFUSAL TEACHES. An agent submits with `--detach` and exits within
    // milliseconds, so an unattended run routinely arrives while the planner is
    // still WRITING the plan. `generating` means wait; `approved` / `declined`
    // mean somebody already decided and the run must stop. They are one word
    // apart in the sentence, and a client must not be parsing sentences
    // (`public-api-conventions.md` §8) — so the status is DATA, and this is the
    // test that keeps it there.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller, { close: false });

    const generating = await approve(caller, key);

    expect(generating.status).toBe(409);
    expect(await generating.json()).toMatchObject({
      code: 'PLAN_NOT_IN_EXPECTED_STATUS',
      planStatus: 'generating',
    });

    // …and the OTHER side of the same field, so the two are provably distinct.
    await plansService.markPlanned(planId, caller.ctx);
    expect((await approve(caller, key)).status).toBe(200);
    const decided = await approve(caller, key);
    expect(decided.status).toBe(409);
    expect(await decided.json()).toMatchObject({ planStatus: 'approved' });
  });

  it('answers 409 for a DECLINED plan, without changing it', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    await plansService.declinePlan(planId, caller.ctx);

    const res = await approve(caller, key);

    expect(res.status).toBe(409);
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('declined');
  });

  it('answers 409 for a `planned` plan holding NO proposals — the refusal, not a 500', async () => {
    // MOTIR-6105. The service refuses this correctly (`PlanHasNoProposalsError`,
    // MOTIR-4146), but the code had no row in `DOMAIN_ERROR_STATUS`, so the v1
    // wrapper logged it as an unhandled fault and answered 500. The in-app route
    // answers 409 for the same refusal, and so must this entrance.
    //
    // The LEGACY shape, built the way `emptyPlanIsNotApprovable.test.ts` builds
    // it: closed with a proposal (the close discards an empty set since
    // MOTIR-4124), then the proposal deleted underneath it.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    await adminDb.planItem.deleteMany({ where: { planId } });

    const res = await approve(caller, key);

    expect(res.status).toBe(409);
    expect(res.status).toBe(DOMAIN_ERROR_STATUS['PLAN_HAS_NO_PROPOSALS']);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_HAS_NO_PROPOSALS');
    // And nothing was decided: the plan waits for the Decline it is owed.
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('planned');
  });

  it('answers 409 PLAN_WALK_INCOMPLETE for a `stopped` plan, naming what is owed', async () => {
    // Bug MOTIR-11701. A walk ran (a lay step) and ended with its card unwritten, so the
    // close lands `stopped`, not `planned` — and this door refuses it by name, with the
    // status as data, exactly as the in-app approve does. Nothing is committed.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller, { close: false });
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'lay', kind: 'lay', targetRef: null },
      caller.ctx,
    );
    await plansService.endPlanStep(planId, 'lay', caller.ctx);
    await plansService.markPlanned(planId, caller.ctx);
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('stopped');

    const res = await approve(caller, key);

    expect(res.status).toBe(409);
    expect(res.status).toBe(DOMAIN_ERROR_STATUS['PLAN_WALK_INCOMPLETE']);
    expect(await res.json()).toMatchObject({
      code: 'PLAN_WALK_INCOMPLETE',
      planId,
      planStatus: 'stopped',
      unwritten: [{ key: null, title: 'the corrected card' }],
    });
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('stopped');
    expect(await adminDb.workItem.count({ where: { title: 'the corrected card' } })).toBe(0);
  });

  // ── B4, and the scope ─────────────────────────────────────────────────────

  it('404s an unknown card and another tenant’s card IDENTICALLY — no existence leak', async () => {
    const mine = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    // ⚠️ A DISTINCT project prefix, and it is load-bearing. Both fixtures
    // default to `PROD`, so the other tenant's `PROD-1` would RESOLVE inside
    // this one — to a different card that happens to share the number — and the
    // test would assert a cross-tenant refusal it never made.
    const theirs = await createV1ProjectCaller({
      permissions: [...OPERATOR],
      workspaceName: 'the other tenant',
      identifier: 'ACME',
    });
    const { key, planId } = await refusedCardWithPlan(theirs);

    const foreign = await approve(mine, key);
    const invented = await approve(mine, 'ACME-9999');

    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(((await foreign.json()) as { code: string }).code).toBe(
      ((await invented.json()) as { code: string }).code,
    );
    // And theirs is untouched.
    expect((await plansService.getPlan(planId, theirs.ctx)).status).toBe('planned');
  });

  it('403s a token without `ai:decide_plan` — INCLUDING one that holds `ai:view_plan`', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    // A SECOND token in the SAME project — the narrower grant, not a second
    // tenant, so the refusal is about the permission and nothing else.
    //
    // ⚠️ IT HOLDS `ai:view_plan` DELIBERATELY (MOTIR-3188). Before the split this
    // grant WAS the approving grant, so a test that merely omitted the AI keys
    // would pass just as happily under the old conflated model and prove nothing
    // about the split. The narrower token here can author a plan and cannot
    // decide one — which is exactly the separation the card exists to create.
    const reader = await withTokenFor(caller.fixture.owner, caller.fixture.workspace, {
      projectId: caller.fixture.projectId,
      permissions: ['project:browse', 'work_item:edit', 'ai:plan', 'ai:view_plan'],
    });

    const res = await approve({ ...caller, ...reader }, key);

    expect(res.status).toBe(403);
    // The body names the key, so a client can say WHICH grant is missing.
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('ai:decide_plan') });
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('planned');
  });

  it('a DISPATCHED AGENT’s grant cannot reach this route at all', async () => {
    // The structural half of the design: the operator approves, never the agent
    // whose card was refused. Enforced by `CLI_TOKEN_GRANT` omitting the key —
    // asserted HERE, beside the route, so widening that constant fails a test
    // that says why rather than quietly opening this door.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:decide_plan');
    // …and since MOTIR-3188 the bound is structural rather than one omission: no
    // MCP tool asserts the decide key either, so widening this grant to the whole
    // AUTHOR key would still not open this door.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:view_plan');

    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);
    const agent = await withTokenFor(caller.fixture.owner, caller.fixture.workspace, {
      projectId: caller.fixture.projectId,
      permissions: [...CLI_TOKEN_GRANT],
    });

    expect((await approve({ ...caller, ...agent }, key)).status).toBe(403);
  });

  // ── the contract ──────────────────────────────────────────────────────────

  it('RETHROWS a real failure — a 409 is ONE refusal, not a bucket for everything', async () => {
    // ⚠️ THE NARROWING IS THE POINT, on both verbs. This catch exists for exactly
    // one typed refusal — the plan is not in a decidable status — and a loop
    // branches on that 409's `planStatus` to WAIT. Collapsing any failure into it
    // would tell an unattended run to sit patiently through an outage.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);
    vi.spyOn(planDecisionService, 'approveForWorkItem').mockRejectedValueOnce(
      new Error('the database went away'),
    );

    const res = await approve(caller, key);

    expect(res.status).toBe(500);
    expect(((await res.json()) as { code?: string }).code).not.toBe('PLAN_NOT_IN_EXPECTED_STATUS');
  });

  it('answers the DOOR’s refusal of a `planned` plan nobody was asked about — 409 NOT DECIDABLE YET, not a 500', async () => {
    // MOTIR-6038. The approve decides the plan's GATE now, so a `planned` plan with no
    // `plan_approval` gate (the pre-backfill shape) is refused by the door — in the one
    // refusal language, and never as `PLAN_NOT_IN_EXPECTED_STATUS`, which a loop reads
    // as "wait". Built for real: the gate the close opened, removed underneath it.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    await adminDb.approvalGate.deleteMany({ where: { subjectId: planId } });

    const res = await approve(caller, key);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PLAN_NOT_DECIDABLE_YET', planId });
    expect((await plansService.getPlan(planId, caller.ctx)).status).toBe('planned');
  });

  it('answers a plan HELD by a revision in flight as the door’s 409 — who holds it, until when', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);
    const until = new Date('2026-09-23T12:00:00.000Z');
    vi.spyOn(planDecisionService, 'approveForWorkItem').mockRejectedValueOnce(
      new PlanRevisionInFlightError(planId, 'Claude Code', until),
    );

    const res = await approve(caller, key);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'PLAN_REVISION_IN_FLIGHT',
      heldBy: 'Claude Code',
      expiresAt: until.toISOString(),
    });
  });

  it('is DECLARED in the operation registry, with the permission the route enforces', () => {
    const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === 'approveWorkItemPlan');
    expect(op).toBeDefined();
    expect(op?.method).toBe('POST');
    expect(op?.path).toBe('/api/v1/work-items/{key}/plan-approval');
    expect(op?.permission).toBe('ai:decide_plan');
    // The statuses it can actually answer, all of them exercised above.
    expect(op?.errorStatuses).toEqual(expect.arrayContaining([404, 409, 422]));
    // It takes NO request body: the card in the path is the whole address, which
    // is the bound. A body would be somewhere for a plan id to creep back in.
    expect(op?.requestBody).toBeUndefined();
  });

  it('leaves the IN-APP approve exactly as it was', async () => {
    // Nothing about the session route changes — the same service, reached the
    // way it always was, on a plan this endpoint never touched.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { planId } = await refusedCardWithPlan(caller);

    expect((await plansService.approvePlan(planId, caller.ctx)).status).toBe('approved');
  });
});

// GET /api/v1/work-items/{key}/plan-approval (MOTIR-4085) — the READ beside the
// decision, so an unattended loop can BOUND what it is about to approve.
//
// The three properties that make it safe to add an approval-shaped read at all:
//
//   • IT IS THE SAME PLAN, resolved by the same walk. A read on a different path
//     resolved a second way would let a loop check the lane of one plan and
//     approve another, which is the exact failure the lane check exists to stop.
//   • IT DECIDES NOTHING. The plan is byte-identical afterwards, so a run that
//     looks and declines has cost the operator's tree nothing at all.
//   • IT WIDENS NOTHING FOR AN AGENT. `ai:view_plan` reads; `ai:decide_plan`
//     decides; `CLI_TOKEN_GRANT` holds neither.
describe('GET /api/v1/work-items/{key}/plan-approval', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('returns the plan the card produced, in the same shape the approve answers', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);

    const res = await readPlan(caller, key);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: V1Plan | null };
    expect(() => workItemPlanSchema.parse(body)).not.toThrow();
    expect(body.plan?.id).toBe(planId);
    expect(body.plan?.status).toBe('planned');
    // An un-materialized `add` has no key, and that null IS the contract.
    expect(body.plan?.proposals[0]?.workItemKey).toBeNull();
  });

  it('DECIDES NOTHING — the plan is exactly where it was afterwards', async () => {
    // ⚠️ THE WHOLE REASON A READ MAY SIT ON AN APPROVAL PATH. A run that looks
    // and then declines must leave the operator's tree untouched, and the proof
    // is that the plan is still decidable by the ordinary route.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller);

    expect((await readPlan(caller, key)).status).toBe(200);
    expect((await readPlan(caller, key)).status).toBe(200);

    const after = await plansService.getPlan(planId, caller.ctx);
    expect(after.status).toBe('planned');
    expect(after.decidedAt).toBeNull();
    // …and the approve still works, on the same plan, from the same address.
    expect((await approve(caller, key)).status).toBe(200);
  });

  it('reads a plan that is still GENERATING, and says so', async () => {
    // The state a run actually meets: the agent submits and exits within
    // milliseconds. A caller has to be able to tell "not finished yet" from
    // "finished and empty", or it would lane-check a half-written plan.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller, { close: false });

    const body = (await (await readPlan(caller, key)).json()) as { plan: V1Plan | null };
    expect(body.plan?.status).toBe('generating');
  });

  it('resolves the SAME plan the approve would decide — asserted by id', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);

    const read = (await (await readPlan(caller, key)).json()) as { plan: V1Plan | null };
    const approved = (await (await approve(caller, key)).json()) as V1Plan;
    expect(approved.id).toBe(read.plan?.id);
  });

  it('answers `plan: null` for a card with no plan anchored at it — NOT an error', async () => {
    // ⚠️ THE COMMON CASE, AND THE REASON IT IS A 200. Almost every card in a
    // project has never been re-planned, so a refusal would make the ordinary
    // state of the tree read as a fault — and would make this the one GET on the
    // surface that is unanswerable for most valid keys. The POST beside it keeps
    // its 422, because there the caller asked for something that cannot be done;
    // a QUERY answering "none" has done exactly what was asked.
    //
    // It is also the SIGNAL: an unattended loop reads `null` as *the agent
    // anchored its re-plan somewhere else*, which is a lane the dispatch prompt
    // offers and calls legitimate.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const item = await makeItem(caller, 'a card whose plan is anchored elsewhere');

    const res = await readPlan(caller, item.identifier);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: V1Plan | null };
    expect(() => workItemPlanSchema.parse(body)).not.toThrow();
    expect(body.plan).toBeNull();
  });

  it('RETHROWS a real failure instead of laundering it into `plan: null`', async () => {
    // ⚠️ THE ARM THAT MAKES THE NULL MEAN ANYTHING. `plan: null` is a positive
    // claim — *nothing is anchored at this card* — and an unattended loop acts on
    // it: it reports the agent's election and stops. If ANY error collapsed into
    // that answer, a database blip would reach the operator as a deliberate
    // choice their agent made — a value accepted and discarded, which is the
    // exact failure this card exists to stop, one layer down. So the catch is
    // narrowed to the ONE typed refusal meaning "nothing is here".
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);
    vi.spyOn(plansService, 'readPlanForWorkItem').mockRejectedValueOnce(
      new Error('the database went away'),
    );

    const res = await readPlan(caller, key);

    expect(res.status).toBe(500);
    // …and emphatically NOT the "nothing is anchored here" answer.
    expect(await res.text()).not.toContain('"plan":null');
  });

  it('404s an unknown card and another tenant’s card IDENTICALLY', async () => {
    const mine = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    // A DISTINCT prefix, for the reason the approve's own test gives: both
    // fixtures default to `PROD`, so the other tenant's key would RESOLVE here.
    const theirs = await createV1ProjectCaller({
      permissions: [...OPERATOR],
      workspaceName: 'the other tenant',
      identifier: 'ACME',
    });
    const { key } = await refusedCardWithPlan(theirs);

    const foreign = await readPlan(mine, key);
    const invented = await readPlan(mine, 'ACME-9999');
    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(((await foreign.json()) as { code: string }).code).toBe(
      ((await invented.json()) as { code: string }).code,
    );
  });

  it('403s a token that cannot BROWSE the project', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);
    const narrowed = await withTokenFor(caller.fixture.owner, caller.fixture.workspace, {
      projectId: caller.fixture.projectId,
      permissions: ['work_item:edit'],
    });

    expect((await readPlan({ ...caller, ...narrowed }, key)).status).toBe(403);
  });

  it('a DISPATCHED AGENT CAN read it and CANNOT decide it — the bound is the decision', async () => {
    // ⚠️ THIS ASSERTION REPLACES ONE THAT CLAIMED THE OPPOSITE, and the
    // correction is the point rather than an embarrassment. The first draft
    // gated this read on `ai:view_plan` and asserted a sandboxed agent could not
    // reach it — a bound that sounded right and bought nothing: the agent that
    // submitted the plan holds its id from its own tool result, so `get_plan`
    // answered the identical document for it already. A gate that stops nobody
    // is worse than no gate, because it is read as protection.
    //
    // So the honest pair is asserted instead, from the constant: the agent may
    // LOOK, exactly as it always could, and may not DECIDE — which is the bound
    // the whole design rests on, and the one no MCP tool asserts at all.
    expect(CLI_TOKEN_GRANT).toContain('project:browse');
    expect(CLI_TOKEN_GRANT).not.toContain('ai:decide_plan');
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);
    const agent = await withTokenFor(caller.fixture.owner, caller.fixture.workspace, {
      projectId: caller.fixture.projectId,
      permissions: [...CLI_TOKEN_GRANT],
    });

    expect((await readPlan({ ...caller, ...agent }, key)).status).toBe(200);
    expect((await approve({ ...caller, ...agent }, key)).status).toBe(403);
  });

  it('is DECLARED in the operation registry, with the permission the route enforces', () => {
    const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === 'getWorkItemPlan');
    expect(op).toBeDefined();
    expect(op?.method).toBe('GET');
    expect(op?.path).toBe('/api/v1/work-items/{key}/plan-approval');
    // READING is `project:browse` — the key its service asserts, the answer this
    // API's table gives every GET, and what `getPlan` declares for the identical
    // document. DECIDING stays `ai:decide_plan` on the POST.
    expect(op?.permission).toBe('project:browse');
    expect(
      WORK_LOOP_OPERATIONS.find((o) => o.operationId === 'approveWorkItemPlan')?.permission,
    ).toBe('ai:decide_plan');
    // NOT 422: a card with no plan is `plan: null` at 200.
    expect(op?.errorStatuses).toEqual([404]);
  });
});

describe('a proposal’s parentKey — the resolved parentRef (MOTIR-4085)', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
  });

  it('resolves a COMMITTED parentRef to its key, beside the raw ref', async () => {
    // ⚠️ WITHOUT THIS A CLIENT CANNOT ANSWER *where is this proposal putting a
    // child?* at all: §7 forbids the cuid on the wire, so `parentRef` is opaque
    // to it. The lane check is a comparison against the iteration's own parent
    // key, and it has nothing to compare without this field.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller, { close: false });
    const parent = await makeItem(caller, 'the container the child lands under');
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'a child of the container' }, parentRef: parent.id }],
      caller.ctx,
    );
    await plansService.markPlanned(planId, caller.ctx);

    const body = (await (await readPlan(caller, key)).json()) as { plan: V1Plan | null };
    const child = body.plan?.proposals.find((p) => p.parentRef === parent.id);
    expect(child?.parentKey).toBe(parent.identifier);
  });

  it('leaves parentKey NULL for a proposal that names no parent', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key } = await refusedCardWithPlan(caller);

    const body = (await (await readPlan(caller, key)).json()) as { plan: V1Plan | null };
    expect(body.plan?.proposals[0]?.parentRef).toBeNull();
    expect(body.plan?.proposals[0]?.parentKey).toBeNull();
  });

  it('leaves parentKey NULL for an intra-plan temp ref — a proposal has no key', async () => {
    // A `planItem:` ref means the plan is growing a subtree of its own. There is
    // no work item to name, and inventing one would be the opposite of the null
    // contract `workItemKey` already keeps.
    const caller = await createV1ProjectCaller({ permissions: [...OPERATOR] });
    const { key, planId } = await refusedCardWithPlan(caller, { close: false });
    const plan = await plansService.getPlan(planId, caller.ctx);
    const first = plan.items[0]!;
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          // The first proposal is a `task`, so a legal child of it is a
          // `subtask` — the same kind-parent matrix a human create is gated on.
          proposedFields: { title: 'a child of another proposal', kind: 'subtask' },
          parentRef: `planItem:${first.id}`,
        },
      ],
      caller.ctx,
    );
    await plansService.markPlanned(planId, caller.ctx);

    const body = (await (await readPlan(caller, key)).json()) as { plan: V1Plan | null };
    const child = body.plan?.proposals.find((p) => p.parentRef?.startsWith('planItem:'));
    expect(child).toBeDefined();
    expect(child?.parentKey).toBeNull();
  });
});
