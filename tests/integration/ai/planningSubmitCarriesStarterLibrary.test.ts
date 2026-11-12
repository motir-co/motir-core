import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

// ════════════════════════════════════════════════════════════════════════════
// Story MOTIR-10162 · Subtask MOTIR-11041 — THE STARTER LIBRARY RIDES EVERY
// PLANNING SUBMIT
// ════════════════════════════════════════════════════════════════════════════
//
// A plan that creates a repository has to judge which starter covers its base, and
// motir-ai cannot read the seed registry. So every planning submit carries the
// active entries as `context.starterLibrary` — a SIBLING of `code` and the
// repository unit, never inside it, because the repository unit is omitted
// outright for a project with no repositories: the very case a repository has to
// be created. `[]` is an answer (no active entry), so the key is always present.
//
// The same two halves as `planningSubmitCarriesOnboardingFlag.test.ts`, for the
// same reason: the value on the wire (real entrances, real Postgres, real client,
// asserted at the HTTP seam) and the call sites (a static walk over `lib/`, so a
// fourth planning submit cannot drop it).

import { db } from '@/lib/db';
import { STARTER_LIBRARY_CONTEXT_FIELD } from '@/lib/ai/starterLibraryContext';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { plansService } from '@/lib/services/plansService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import type { ProjectContext } from '@/lib/projects';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import { SEED_SOURCE_FLY_STARTER } from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { resetSeedRegistry } from '../../helpers/seedRegistryShipped';
import {
  allSubmitSitesInLib,
  planningSitesMissing,
  submitSites,
} from '../../helpers/submitJobSites';
import type { WorkItemFixture } from '../../fixtures';

const ORIGIN = 'http://motir-ai.starter-library.test';

// The WIRE STRING, written out: motir-ai spells it in its own repository and no
// shared type binds the two, so importing it would only agree with itself.
const WIRE_KEY = 'starterLibrary';

const bodies: Record<string, unknown>[] = [];
let agent: MockAgent;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'motir-starter-library-'));
  const fixture = join(dir, 'jobs.json');
  writeFileSync(fixture, JSON.stringify({}));
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixture);

  agent = new MockAgent();
  agent.enableNetConnect();
  setGlobalDispatcher(agent);
  // Installed ONCE: the observers live in module scope.
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

afterEach(async () => {
  // The registry is shared platform data no truncate reaches.
  await resetSeedRegistry();
});

const ctxOf = (b: Record<string, unknown>): Record<string, unknown> =>
  (b['context'] ?? {}) as Record<string, unknown>;

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

/** The caller's `ProjectContext`, built from a fresh row the way both real callers do. */
async function projectCtx(fx: WorkItemFixture): Promise<ProjectContext> {
  const project = await projectsService.assertProjectInWorkspace(fx.projectId, fx.workspaceId);
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: toProjectDTO(project),
  };
}

/** The body of the one submit `drive` made. */
async function submitted(drive: () => Promise<unknown>): Promise<Record<string, unknown>> {
  bodies.length = 0;
  await drive();
  expect(bodies, 'the entrance made no submit').toHaveLength(1);
  return ctxOf(bodies[0]!);
}

describe('every planning entrance sends the active starter library', () => {
  it('a project with NO repositories gets it — beside the omitted repository unit, not inside it', async () => {
    const fx = await makeFixture();
    expect(await projectRepoSetService.listByProject(fx.projectId, fx.ctx)).toEqual([]);
    const active = await seedRegistryService.listActiveEntries();
    expect(active.length, 'the shipped registry should hold active entries').toBeGreaterThan(0);

    const gc = await projectCtx(fx);
    const context = await submitted(() =>
      aiGenerationService.startGeneration(gc, { prompt: 'build a thing' }),
    );
    // The repository unit is absent for this project — which is exactly why the
    // library cannot live inside it.
    expect(context).not.toHaveProperty('repositories');
    expect(context[WIRE_KEY]).toEqual(JSON.parse(JSON.stringify(active)));
  });

  it('the routing run, the shared plan-edit submit, `submitRevise` and `submitResume` send it too', async () => {
    const fx = await makeFixture();
    const planId = await plannedPlan(fx);
    const c = await projectCtx(fx);
    const expected = JSON.parse(JSON.stringify(await seedRegistryService.listActiveEntries()));

    const contexts: [string, Record<string, unknown>][] = [
      ['routing', await submitted(() => aiGenerationService.startRoutingRun(c))],
      ['augment', await submitted(() => aiPlanEditsService.submitAugment('add login', c))],
      ['revise', await submitted(() => aiPlanEditsService.submitRevise(planId, 'split it', c))],
      [
        'resume',
        await submitted(() => aiPlanEditsService.submitResume(planId, 'job-before', c, fx.ownerId)),
      ],
    ];
    for (const [name, context] of contexts) {
      expect(Object.prototype.hasOwnProperty.call(context, WIRE_KEY), `${name} dropped it`).toBe(
        true,
      );
      expect(context[WIRE_KEY], name).toEqual(expected);
    }
  });

  it('a project WITH a repository set gets the same library beside its repository unit', async () => {
    const fx = await makeFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    const gc = await projectCtx(fx);
    const context = await submitted(() =>
      aiGenerationService.startGeneration(gc, { prompt: 'build a thing' }),
    );
    expect(context).toHaveProperty('repositories');
    expect(JSON.stringify(context['repositories'])).not.toContain(WIRE_KEY);
    expect(context[WIRE_KEY]).toEqual(
      JSON.parse(JSON.stringify(await seedRegistryService.listActiveEntries())),
    );
  });

  it('an entry retired between two submits is gone from the second', async () => {
    const fx = await makeFixture();
    const c = await projectCtx(fx);
    const keysOf = (c: Record<string, unknown>) =>
      (c[WIRE_KEY] as { key: string }[]).map((e) => e.key);
    const before = await submitted(() => aiPlanEditsService.submitAugment('one', c));
    expect(keysOf(before)).toContain(SEED_SOURCE_FLY_STARTER);

    await adminDb.seedRegistryEntry.update({
      where: { key: SEED_SOURCE_FLY_STARTER },
      data: { status: 'retired' },
    });
    const after = await submitted(() => aiPlanEditsService.submitAugment('two', c));
    expect(keysOf(after)).not.toContain(SEED_SOURCE_FLY_STARTER);
  });

  it('sends `[]`, still present, when no entry is active', async () => {
    const fx = await makeFixture();
    await adminDb.seedRegistryEntry.updateMany({ data: { status: 'retired' } });
    const gc = await projectCtx(fx);
    const context = await submitted(() =>
      aiGenerationService.startGeneration(gc, { prompt: 'build a thing' }),
    );
    expect(Object.prototype.hasOwnProperty.call(context, WIRE_KEY)).toBe(true);
    expect(context[WIRE_KEY]).toEqual([]);
  });
});

const REQUIRED_TOKEN = '[STARTER_LIBRARY_CONTEXT_FIELD]';

describe('no planning `submitJob` call site can drop the starter library', () => {
  it('every planning submit in `lib/` names the constant, and the walk found them', async () => {
    const { files, sites } = await allSubmitSitesInLib();
    expect(files.length, 'the source walk found no files').toBeGreaterThan(50);
    const planning = sites.filter((s) => s.kind === 'plan');
    expect(planning.length).toBeGreaterThanOrEqual(3);
    expect(planningSitesMissing(sites, REQUIRED_TOKEN)).toEqual([]);
  });

  it('THE DETECTOR CAN GO RED — a submit without it is flagged, the fixed one is not', () => {
    const bypassing = `
      const { jobId } = await submitJob('plan', tenant, { prompt }, { userId: ctx.userId });`;
    expect(
      planningSitesMissing(submitSites('fake/bypass.ts', bypassing), REQUIRED_TOKEN),
    ).toHaveLength(1);
    const fixed = bypassing.replace(
      '{ prompt }',
      '{ prompt, [STARTER_LIBRARY_CONTEXT_FIELD]: starterLibrary }',
    );
    expect(planningSitesMissing(submitSites('fake/fixed.ts', fixed), REQUIRED_TOKEN)).toEqual([]);
    // Named only in a comment is still an offender.
    const commented = `
      await submitJob('plan', tenant, {
        // [STARTER_LIBRARY_CONTEXT_FIELD] rides every planning submit.
        prompt,
      }, { userId });`;
    expect(
      planningSitesMissing(submitSites('fake/commented.ts', commented), REQUIRED_TOKEN),
    ).toHaveLength(1);
  });

  it('the required token is the exported constant’s name, and the constant is the wire key', () => {
    expect(REQUIRED_TOKEN).toBe('[STARTER_LIBRARY_CONTEXT_FIELD]');
    expect(STARTER_LIBRARY_CONTEXT_FIELD).toBe(WIRE_KEY);
  });
});
