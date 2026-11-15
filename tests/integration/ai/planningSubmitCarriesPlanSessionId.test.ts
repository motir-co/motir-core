import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

// ════════════════════════════════════════════════════════════════════════════
// Bug MOTIR-11294 — EVERY PLANNING SUBMIT NAMES ITS CONVERSATION
// ════════════════════════════════════════════════════════════════════════════
//
// motir-ai keys a conversation's code-graph pointers by the job's concurrency key,
// `session:<aiProjectId>:<scopeKey>`, which every later session with the same
// anchors SHARES, and since MOTIR-11292 it resets the key only for a turn that
// NAMES its conversation. Only an offer's start used to, so the second expand of a
// card — a new session here — inherited the first one's pointers and opened on a
// false "your code graph was refreshed since the last turn" note. Every planning
// submit now sends the plan session's id as `context.planSessionId`; a door that
// opens a NEW session allocates its id before the submit and the session is
// created with it.
//
// The two halves of the sibling `planningSubmitCarries*` suites: the value on the
// wire (real entrances, real Postgres, real client, asserted at the HTTP seam) and
// the call sites (a static walk over `lib/`, so a later planning submit cannot
// drop it).

import { db } from '@/lib/db';
import { PLAN_SESSION_ID_CONTEXT_FIELD } from '@/lib/ai/planSessionContext';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture as makeFixture, createTestWorkItem } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import {
  allSubmitSitesInLib,
  planningSitesMissing,
  submitSites,
} from '../../helpers/submitJobSites';
import type { WorkItemFixture } from '../../fixtures';

const ORIGIN = 'http://motir-ai.plan-session-id.test';

// The WIRE STRING, written out: motir-ai spells it in its own repository
// (`readPlanSessionId`) and no shared type binds the two.
const WIRE_KEY = 'planSessionId';

const bodies: Record<string, unknown>[] = [];
let agent: MockAgent;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motir-plan-session-id-'));
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
    'TRUNCATE TABLE "plan_change_session", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateJobRuns();
  await truncateAuthTables();
});

const ctxOf = (b: Record<string, unknown>): Record<string, unknown> =>
  (b['context'] ?? {}) as Record<string, unknown>;

async function projectCtx(fx: WorkItemFixture): Promise<ProjectContext> {
  const project = await projectsService.assertProjectInWorkspace(fx.projectId, fx.workspaceId);
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: toProjectDTO(project),
  };
}

/** The context of the one submit `drive` made. */
async function submitted(drive: () => Promise<unknown>): Promise<Record<string, unknown>> {
  bodies.length = 0;
  await drive();
  expect(bodies, 'the entrance made no submit').toHaveLength(1);
  return ctxOf(bodies[0]!);
}

/** The session row a plan belongs to, read as the platform. */
async function sessionOfPlan(planId: string) {
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  return adminDb.planChangeSession.findUniqueOrThrow({ where: { id: plan.sessionId! } });
}

describe('every planning entrance names the plan session it belongs to', () => {
  it('the reproduction: two expands of the same card send two DIFFERENT sessions, each the one its plan opened', async () => {
    const fx = await makeFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story: Login' });
    const c = await projectCtx(fx);

    let first!: { planId: string };
    const one = await submitted(async () => {
      first = await aiPlanEditsService.submitExpand(story.identifier, c);
    });
    let second!: { planId: string };
    const two = await submitted(async () => {
      second = await aiPlanEditsService.submitExpand(story.identifier, c);
    });

    // Both share motir-ai's concurrency key (the same anchor), so the id is the only
    // thing that tells the second conversation from the first.
    expect(one['rootItemKey']).toBe(two['rootItemKey']);
    expect(typeof one[WIRE_KEY]).toBe('string');
    expect(one[WIRE_KEY]).not.toBe(two[WIRE_KEY]);

    const s1 = await sessionOfPlan(first.planId);
    const s2 = await sessionOfPlan(second.planId);
    expect(s1.id).toBe(one[WIRE_KEY]);
    expect(s2.id).toBe(two[WIRE_KEY]);
    expect(s1.origin).toBe('expand');
    expect(s1.targetKeys).toEqual([story.identifier]);
  });

  it('a generation and a one-shot augment send the id of the session their plan opens', async () => {
    const fx = await makeFixture();
    const c = await projectCtx(fx);

    let gen!: { planId: string };
    const g = await submitted(async () => {
      gen = await aiGenerationService.startGeneration(c, { prompt: 'build a thing' });
    });
    expect((await sessionOfPlan(gen.planId)).id).toBe(g[WIRE_KEY]);

    let aug!: { planId: string };
    const a = await submitted(async () => {
      aug = await aiPlanEditsService.submitAugment('add login', c);
    });
    expect((await sessionOfPlan(aug.planId)).id).toBe(a[WIRE_KEY]);
    expect(a[WIRE_KEY]).not.toBe(g[WIRE_KEY]);
  });

  it("a revision and a resume send the plan's OWN session", async () => {
    const fx = await makeFixture();
    const c = await projectCtx(fx);
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
    expect(plan.sessionId).toBeTruthy();

    const revise = await submitted(() => aiPlanEditsService.submitRevise(plan.id, 'split it', c));
    expect(revise[WIRE_KEY]).toBe(plan.sessionId);

    const resume = await submitted(() =>
      aiPlanEditsService.submitResume(plan.id, 'job-before', c, fx.ownerId, plan.sessionId!),
    );
    expect(resume[WIRE_KEY]).toBe(plan.sessionId);
  });

  it('the routing run opens no session and names none', async () => {
    const fx = await makeFixture();
    const context = await submitted(async () =>
      aiGenerationService.startRoutingRun(await projectCtx(fx)),
    );
    expect(Object.prototype.hasOwnProperty.call(context, WIRE_KEY)).toBe(false);
  });
});

const REQUIRED_TOKEN = '[PLAN_SESSION_ID_CONTEXT_FIELD]';

describe('no planning `submitJob` call site can drop the plan session id', () => {
  it('every planning submit in `lib/` names the constant — save the routing run, which has no session', async () => {
    const { files, sites } = await allSubmitSitesInLib();
    expect(files.length, 'the source walk found no files').toBeGreaterThan(50);
    expect(sites.filter((s) => s.kind === 'plan').length).toBeGreaterThanOrEqual(3);
    const missing = planningSitesMissing(sites, REQUIRED_TOKEN);
    // EXACTLY one offender, and it is `startRoutingRun`: the one planning submit that
    // opens no plan and so has no session to name. A second entry is a new submit
    // that forgot the field.
    expect(missing).toEqual([
      `lib/services/aiGenerationService.ts: submitJob('plan', …) sends no ${REQUIRED_TOKEN}`,
    ]);
    const routing = sites.find(
      (s) =>
        s.kind === 'plan' &&
        s.file === 'lib/services/aiGenerationService.ts' &&
        !s.args.includes(REQUIRED_TOKEN),
    );
    expect(routing?.args).toContain('prompt: null');
  });

  it('THE DETECTOR CAN GO RED — a submit without it is flagged, the fixed one is not', () => {
    const bypassing = `
      const { jobId } = await submitJob('plan', tenant, { prompt }, { userId: ctx.userId });`;
    expect(
      planningSitesMissing(submitSites('fake/bypass.ts', bypassing), REQUIRED_TOKEN),
    ).toHaveLength(1);
    const fixed = bypassing.replace(
      '{ prompt }',
      '{ prompt, [PLAN_SESSION_ID_CONTEXT_FIELD]: sessionId }',
    );
    expect(planningSitesMissing(submitSites('fake/fixed.ts', fixed), REQUIRED_TOKEN)).toEqual([]);
  });

  it('the required token is the exported constant’s name, and the constant is the wire key', () => {
    expect(REQUIRED_TOKEN).toBe('[PLAN_SESSION_ID_CONTEXT_FIELD]');
    expect(PLAN_SESSION_ID_CONTEXT_FIELD).toBe(WIRE_KEY);
  });
});
