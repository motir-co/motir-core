import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

// Task MOTIR-1101 · Subtask MOTIR-8450 — the plan a submit WRITES carries what a
// Grill me session settled on it as `context.requirement`, the key motir-ai's
// `readSuppliedPart1` reads, so the run does not re-ask a settled requirement.
// Asserted on the request body at the HTTP seam, as the consent- and
// onboarding-flag suites beside this one do.

import { db } from '@/lib/db';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';

const ORIGIN = 'http://motir-ai.sharpened-requirement.test';
const bodies: Record<string, unknown>[] = [];
let agent: MockAgent;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motir-sharpened-req-'));
  const fixture = join(dir, 'jobs.json');
  writeFileSync(fixture, JSON.stringify({}));
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixture);
  agent = new MockAgent();
  agent.enableNetConnect();
  setGlobalDispatcher(agent);
  const { installAiJobsBoundaryMock, observeAiJobSubmit } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
  observeAiJobSubmit((raw) => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  bodies.length = 0;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateJobRuns();
  await truncateAuthTables();
});

const contextOf = (b: Record<string, unknown>): Record<string, unknown> =>
  (b['context'] ?? {}) as Record<string, unknown>;

async function freshCtx(fx: WorkItemFixture): Promise<ProjectContext> {
  const project = await projectsService.assertProjectInWorkspace(fx.projectId, fx.workspaceId);
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: toProjectDTO(project),
  };
}

async function plannedPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Revisable', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The proposal', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

const SIX = {
  outcome: 'Finance can export invoices.',
  behaviour: '- Who exports? — Only admins.',
  scopeEdge: '',
  constraints: '- Reuse the CSV columns.',
  acceptance: '- An empty export says so.',
  assumptions: '- Invoices are paginated.',
};

async function sharpen(planId: string): Promise<void> {
  await adminDb.plan.update({
    where: { id: planId },
    data: {
      sharpenedRequirement: {
        ...SIX,
        plannerAssumptions: [{ question: 'Date format?', recommendation: 'ISO 8601' }],
        settledAt: '2026-10-13T00:00:00.000Z',
      },
    },
  });
}

describe('a plan-writing submit carries the plan’s sharpened requirement', () => {
  it('submitRevise and submitSessionRevision send exactly the six fields', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await freshCtx(fx);
    const planId = await plannedPlan(fx);
    await sharpen(planId);

    await aiPlanEditsService.submitRevise(planId, 'split the second story', ctx);
    const revise = contextOf(bodies[0]!);
    expect(revise['requirement']).toEqual(SIX);
    expect(revise['planId']).toBe(planId);
    expect(revise['prompt']).toBe('split the second story');
    expect(revise['onboarding']).toBeDefined();

    // A second plan, revised through the session door (a revision holds a lease).
    const second = await plannedPlan(fx);
    await sharpen(second);
    bodies.length = 0;
    await aiPlanEditsService.submitSessionRevision(second, 'and the third', ctx);
    expect(contextOf(bodies[0]!)['requirement']).toEqual(SIX);
  });

  it('submitResume sends it beside the unchanged resume', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await freshCtx(fx);
    const planId = await plannedPlan(fx);
    await sharpen(planId);

    await aiPlanEditsService.submitResume(planId, 'job-before', ctx, ctx.userId, 'session-resumed');
    expect(bodies).toHaveLength(1);
    expect(contextOf(bodies[0]!)['requirement']).toEqual(SIX);
    expect(contextOf(bodies[0]!)).not.toHaveProperty('planId');
    expect(JSON.stringify(bodies[0])).toContain('job-before');
  });

  it('sends NO requirement key when the plan carries none', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await freshCtx(fx);
    const planId = await plannedPlan(fx);

    await aiPlanEditsService.submitRevise(planId, 'split it', ctx);
    expect(Object.prototype.hasOwnProperty.call(contextOf(bodies[0]!), 'requirement')).toBe(false);
    bodies.length = 0;
    await aiPlanEditsService.submitResume(planId, 'job-before', ctx, ctx.userId, 'session-resumed');
    expect(Object.prototype.hasOwnProperty.call(contextOf(bodies[0]!), 'requirement')).toBe(false);
  });

  it('a submit with no target plan is unchanged — no requirement key', async () => {
    const fx = await makeWorkItemFixture();
    const ctx = await freshCtx(fx);
    await aiPlanEditsService.submitAugment('add a login flow', ctx);
    const augment = contextOf(bodies[0]!);
    expect(Object.prototype.hasOwnProperty.call(augment, 'requirement')).toBe(false);
    expect(augment['onboarding']).toBeDefined();
    expect(augment['generateExplanations']).toBeDefined();
  });
});
