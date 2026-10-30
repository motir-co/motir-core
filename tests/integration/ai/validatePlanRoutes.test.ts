import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { POST as validatePlanPOST } from '@/app/api/internal/ai/validate-plan/route';
import { POST as validatePlanSprintPOST } from '@/app/api/internal/ai/validate-plan-sprint/route';
import { POST as validatePlanForestPOST } from '@/app/api/internal/ai/validate-plan-forest/route';
import { makeWorkItemFixture, createTestProject, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST — the two pre-commit plan-validation endpoints (Subtask 7.28.2)
// end-to-end through the REAL routes, real Postgres. Asserts the auth grants
// (§4a service bearer + §4b job token) identically to plan-delta, the 400/404/409
// branches, and that a happy path returns the validity DTO VERBATIM from
// planValidityService.

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function req(path: string, opts: { bearer?: string; token?: string; body: unknown }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request(`http://core${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
}

const tokenFor = (fx: WorkItemFixture): string =>
  mintJobToken({ userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId: fx.projectId });

const mk = (
  fx: WorkItemFixture,
  title: string,
  kind: 'story' | 'task' | 'subtask',
  parentId?: string,
) =>
  workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind,
      title,
      parentId,
      // Typed so a leaf is not UNDER-AUTHORED (MOTIR-5427); containers cannot carry one.
      ...(kind === 'task' || kind === 'subtask' ? { type: 'code' as const } : {}),
    },
    fx.ctx,
  );

/** A `planned` plan whose single `modify` makes `targetId` blocked_by `blockerId`. */
async function planBlocking(
  fx: WorkItemFixture,
  targetId: string,
  blockerId: string,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: targetId, patch: { blockedByAdd: [blockerId] } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

describe('POST /api/internal/ai/validate-plan', () => {
  it('401s a missing service bearer and a tampered token (before any work)', async () => {
    const fx = await makeWorkItemFixture();
    const noBearer = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        token: tokenFor(fx),
        body: { planId: 'x', targetKey: 'y' },
      }),
    );
    expect(noBearer.status).toBe(401);

    const [payload] = tokenFor(fx).split('.');
    const badToken = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: `${payload}.deadbeef`,
        body: { planId: 'x', targetKey: 'y' },
      }),
    );
    expect(badToken.status).toBe(401);
  });

  it('400s a missing targetKey and an unknown condition', async () => {
    const fx = await makeWorkItemFixture();
    const noTarget = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: 'p' },
      }),
    );
    expect(noTarget.status).toBe(400);

    const badCondition = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: 'p', targetKey: 'MOTIR-1', condition: 'whenever' },
      }),
    );
    expect(badCondition.status).toBe(400);
  });

  it('404s an unknown planId and an unknown targetKey', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');

    const badPlan = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: 'plan_missing', targetKey: story.identifier },
      }),
    );
    expect(badPlan.status).toBe(404);

    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    const badTarget = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: plan.id, targetKey: 'MOTIR-999999' },
      }),
    );
    expect(badTarget.status).toBe(404);
  });

  it('returns the validity DTO verbatim — valid and invalid bodies', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    const child = await mk(fx, 'Child', 'subtask', story.id);
    // One level down under its own root — the child's depth (MOTIR-6411).
    const elsewhere = await mk(fx, 'Elsewhere', 'story');
    const outside = await mk(fx, 'Outside', 'task', elsewhere.id);
    const planId = await planBlocking(fx, child.id, outside.id);

    const invalid = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId, targetKey: story.identifier },
      }),
    );
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toEqual({
      key: story.identifier,
      valid: false,
      blockers: [
        {
          item: child.identifier,
          blockedBy: outside.identifier,
          blockerStatus: 'todo',
          blockerSprintId: null,
        },
      ],
      // The cross-parent half (MOTIR-6370), carried verbatim like the rest: the
      // child's parent does not block the outsider's, so the edge is uncovered.
      invalidEdges: [
        {
          item: child.identifier,
          blockedBy: outside.identifier,
          itemParent: story.identifier,
          blockerParent: elsewhere.identifier,
        },
      ],
      crossLevelEdges: [],
      advisories: [],
      softBlocks: [],
      sectionFindings: expect.any(Array),
    });

    // A no-op plan over the same target is valid.
    const emptyPlan = await plansService.createPlan(fx.projectId, { title: 'Empty' }, fx.ctx);
    await plansService.markPlanned(emptyPlan.id, fx.ctx);
    const valid = await validatePlanPOST(
      req('/api/internal/ai/validate-plan', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: emptyPlan.id, targetKey: story.identifier },
      }),
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      key: story.identifier,
      valid: true,
      blockers: [],
      // The cross-parent half (MOTIR-6370), carried verbatim like the rest.
      invalidEdges: [],
      crossLevelEdges: [],
      advisories: [],
      softBlocks: [],
      sectionFindings: expect.any(Array),
    });
  });
});

describe('POST /api/internal/ai/validate-plan-sprint', () => {
  it('401s a missing service bearer', async () => {
    const fx = await makeWorkItemFixture();
    const res = await validatePlanSprintPOST(
      req('/api/internal/ai/validate-plan-sprint', { token: tokenFor(fx), body: { planId: 'x' } }),
    );
    expect(res.status).toBe(401);
  });

  it('400s a missing planId', async () => {
    const fx = await makeWorkItemFixture();
    const res = await validatePlanSprintPOST(
      req('/api/internal/ai/validate-plan-sprint', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {},
      }),
    );
    expect(res.status).toBe(400);
  });

  it('409s when the project has no active sprint', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    const res = await validatePlanSprintPOST(
      req('/api/internal/ai/validate-plan-sprint', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: plan.id },
      }),
    );
    expect(res.status).toBe(409);
  });

  it('returns the sprint validity DTO verbatim for an invalid projected sprint', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    const inSprint = await mk(fx, 'In sprint', 'task');
    await adminDb.workItem.update({ where: { id: inSprint.id }, data: { sprintId: sprint.id } });
    const backlog = await mk(fx, 'Backlog blocker', 'task');
    const planId = await planBlocking(fx, inSprint.id, backlog.id);

    const res = await validatePlanSprintPOST(
      req('/api/internal/ai/validate-plan-sprint', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sprintId: sprint.id,
      valid: false,
      blockers: [
        {
          item: inSprint.identifier,
          blockedBy: backlog.identifier,
          blockerStatus: 'todo',
          blockerSprintId: null,
        },
      ],
    });
  });
});

describe('POST /api/internal/ai/validate-plan-forest', () => {
  it('401s a missing service bearer', async () => {
    const fx = await makeWorkItemFixture();
    const res = await validatePlanForestPOST(
      req('/api/internal/ai/validate-plan-forest', { token: tokenFor(fx), body: { planId: 'x' } }),
    );
    expect(res.status).toBe(401);
  });

  it('400s a missing planId and an unknown condition (NO targetKey is required)', async () => {
    const fx = await makeWorkItemFixture();
    const noPlan = await validatePlanForestPOST(
      req('/api/internal/ai/validate-plan-forest', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {},
      }),
    );
    expect(noPlan.status).toBe(400);

    const badCondition = await validatePlanForestPOST(
      req('/api/internal/ai/validate-plan-forest', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: 'p', condition: 'whenever' },
      }),
    );
    expect(badCondition.status).toBe(400);
  });

  it('404s an unknown planId', async () => {
    const fx = await makeWorkItemFixture();
    const res = await validatePlanForestPOST(
      req('/api/internal/ai/validate-plan-forest', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: 'plan_missing' },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns the plan validity DTO verbatim — valid (empty plan) and invalid (cross-project gate) bodies', async () => {
    const fx = await makeWorkItemFixture();

    // Valid: an empty plan over an empty project.
    const emptyPlan = await plansService.createPlan(fx.projectId, { title: 'Empty' }, fx.ctx);
    await plansService.markPlanned(emptyPlan.id, fx.ctx);
    const valid = await validatePlanForestPOST(
      req('/api/internal/ai/validate-plan-forest', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: emptyPlan.id },
      }),
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({
      planId: emptyPlan.id,
      valid: true,
      blockers: [],
      // The route is a thin transport, so it inherits the APPROVABILITY half
      // verbatim (MOTIR-3575) — which is what the generator's pre-commit
      // post-condition needs it to carry.
      rejections: [],
      // The cross-parent half (MOTIR-6370), carried verbatim like the rest.
      invalidEdges: [],
      crossLevelEdges: [],
      sectionFindings: expect.any(Array),
      // The link advisories ride beside the verdict (MOTIR-9873); none here.
      advisories: [],
      // …and so do the `modify`s approve would re-open (MOTIR-10106); none here.
      rescopeWarnings: [],
    });

    // Invalid: a new root add gated by a not-done cross-project item.
    const projectQ = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'BETA',
    });
    const qBlocker = await workItemsService.createWorkItem(
      { projectId: projectQ.id, kind: 'task', title: 'Cross-project blocker' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    const withItems = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Gated', kind: 'task' },
          blockedByRefs: [qBlocker.id],
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const gatedId = withItems.items.find((i) => i.proposedFields?.title === 'Gated')!.id;

    const invalid = await validatePlanForestPOST(
      req('/api/internal/ai/validate-plan-forest', {
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { planId: plan.id },
      }),
    );
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toEqual({
      planId: plan.id,
      valid: false,
      // Finishability fails; APPROVABILITY passes — a cross-project blocker is a
      // legal edge and resolves at the workspace tier, so the plan is malformed
      // in no way. The two halves answering differently on one plan is exactly
      // what makes reporting them separately worth doing (MOTIR-3575).
      rejections: [],
      blockers: [
        {
          item: `planItem:${gatedId}`,
          blockedBy: qBlocker.identifier,
          blockerStatus: 'todo',
          blockerSprintId: null,
        },
      ],
      // The cross-parent half (MOTIR-6370), carried verbatim like the rest.
      invalidEdges: [],
      crossLevelEdges: [],
      sectionFindings: expect.any(Array),
      // The shape advisories ride beside the verdict (MOTIR-9873, MOTIR-10087):
      // a bare `{ title, kind }` add is UNDER-AUTHORED, and says so.
      advisories: [
        {
          kind: 'shape',
          item: `planItem:${gatedId}`,
          severity: 'under-authored',
          criteria: 'no-heading',
        },
      ],
      rescopeWarnings: [],
    });
  });

  it('answers a mislabelled link in a PROPOSED body in `advisories`, beside an unchanged verdict (MOTIR-9873)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await mk(fx, 'Story', 'story');
    // A second parent for the clean plan: an open plan holds the parent it adds under.
    const otherStory = await mk(fx, 'Other story', 'story');
    const opened = await mk(fx, 'Opened', 'subtask', story.id);
    const link = (label: string, id: string) => `[${label}](motir:${id})`;

    // A plan whose proposed body links an id that opens NO card.
    const broken = await plansService.createPlan(fx.projectId, { title: 'Broken' }, fx.ctx);
    const withAdd = await plansService.addProposals(
      broken.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'New child',
            kind: 'subtask',
            type: 'code',
            descriptionMd: `Reads ${link('PROD-404', 'cl_no_such_card')}.`,
          },
          parentRef: story.id,
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(broken.id, fx.ctx);
    const addId = withAdd.items.find((i) => i.proposedFields?.title === 'New child')!.id;

    // The same plan shape with a link whose label names the card its id opens.
    const clean = await plansService.createPlan(fx.projectId, { title: 'Clean' }, fx.ctx);
    await plansService.addProposals(
      clean.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Clean child',
            kind: 'subtask',
            type: 'code',
            descriptionMd: `Reads ${link(opened.identifier, opened.id)}.`,
          },
          parentRef: otherStory.id,
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(clean.id, fx.ctx);

    const post = (planId: string) =>
      validatePlanForestPOST(
        req('/api/internal/ai/validate-plan-forest', {
          bearer: SERVICE_SECRET,
          token: tokenFor(fx),
          body: { planId },
        }),
      );

    const brokenRes = await post(broken.id);
    expect(brokenRes.status).toBe(200);
    const brokenBody = await brokenRes.json();
    expect(brokenBody.advisories).toEqual([
      {
        kind: 'shape',
        item: `planItem:${addId}`,
        severity: 'likely-mislabelled-link',
        label: 'PROD-404',
        targetId: 'cl_no_such_card',
        targetKey: null,
        field: 'descriptionMd',
      },
    ]);

    const cleanRes = await post(clean.id);
    expect(cleanRes.status).toBe(200);
    const cleanBody = await cleanRes.json();
    expect(cleanBody.advisories).toEqual([]);

    // `valid` is the verdict's alone: the advisory never moves it.
    expect(brokenBody.valid).toBe(true);
    expect(cleanBody.valid).toBe(true);
    expect(brokenBody.blockers).toEqual([]);
    expect(brokenBody.rejections).toEqual([]);
  });
});
