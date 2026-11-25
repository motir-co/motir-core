import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The PRODUCER seam of the planning-cadence setting (Story MOTIR-12203 ·
// MOTIR-12204): the project's cadence reaches motir-ai on the plan job envelope's
// `context` and plan.py on `get_project_state`, because neither planner reads
// motir-core's database. Real Postgres (the motir-core convention), the shape of
// `tests/ai/finalCheck.test.ts`:
//
//   1. The stored NULL (never written) resolves to `story` at submit time, so a
//      project nobody has touched keeps today's walk.
//   2. An explicit `subtask` reaches the envelope as `subtask`, and `story` is
//      sent PRESENT too — every producer sends it unconditionally.
//   3. The value is resolved per submit: a job already submitted keeps the
//      cadence it was handed when the setting is saved afterwards.
//   4. The assertion is made on the SERIALIZED body, the only form motir-ai sees.

import { db } from '@/lib/db';
import {
  PLANNING_CADENCE_CONTEXT_FIELD,
  resolvePlanningCadenceForJob,
} from '@/lib/ai/planningCadence';
import {
  AI_PLANNING_CADENCE_DEFAULT,
  isPlanningCadence,
  resolvePlanningCadence,
} from '@/lib/projectAiSettings/limits';
import { submitJob } from '@/lib/ai/motirAiClient';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { projectStateService } from '@/lib/services/projectStateService';
import { summarizeProjectState } from '@/lib/mcp/tools/getProjectState';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The WIRE STRING, written out rather than imported from the code under test:
// motir-ai and plan.py read this same literal, and a test that read the name out
// of the module would agree with itself and prove nothing about the contract.
const WIRE_KEY = 'planningCadence';

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedProject(): Promise<{
  userId: string;
  workspaceId: string;
  projectId: string;
  identifier: string;
}> {
  const user = await usersService.createUser({
    email: `cadence-${randomToken(6)}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const identifier = `PC${randomToken(4)
    .toUpperCase()
    .replace(/[^A-Z]/g, 'X')}`;
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: identifier,
    identifier,
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    identifier: project.identifier,
  };
}

describe('resolvePlanningCadence — the one place the default lives', () => {
  it('reads an unset or unknown value as story and a known value as itself', () => {
    expect(AI_PLANNING_CADENCE_DEFAULT).toBe('story');
    expect(resolvePlanningCadence(null)).toBe('story');
    expect(resolvePlanningCadence(undefined)).toBe('story');
    expect(resolvePlanningCadence('epic')).toBe('story');
    expect(resolvePlanningCadence(1)).toBe('story');
    expect(resolvePlanningCadence('subtask')).toBe('subtask');
    expect(resolvePlanningCadence('story')).toBe('story');
  });

  it('accepts exactly the two cadences as members', () => {
    expect(isPlanningCadence('story')).toBe(true);
    expect(isPlanningCadence('subtask')).toBe(true);
    expect(isPlanningCadence('Story')).toBe(false);
    expect(isPlanningCadence(null)).toBe(false);
  });
});

describe('resolvePlanningCadenceForJob — the setting, resolved at submit time', () => {
  it('a project that has never touched the setting resolves to story', async () => {
    const seed = await seedProject();

    // The state every project that predates the column is in — asserted on the
    // row, so this is the real unset case and not a written `story`.
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: seed.projectId } });
    expect(row.aiPlanningCadence).toBeNull();

    await expect(
      resolvePlanningCadenceForJob(seed.projectId, {
        userId: seed.userId,
        workspaceId: seed.workspaceId,
      }),
    ).resolves.toBe('story');
  });

  it('an explicit subtask resolves to subtask, and saving story resolves to story', async () => {
    const seed = await seedProject();
    const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };

    await projectAiSettingsService.updateAiSettings(
      seed.identifier,
      { aiPlanningCadence: 'subtask' },
      ctx,
    );
    await expect(resolvePlanningCadenceForJob(seed.projectId, ctx)).resolves.toBe('subtask');

    await projectAiSettingsService.updateAiSettings(
      seed.identifier,
      { aiPlanningCadence: 'story' },
      ctx,
    );
    await expect(resolvePlanningCadenceForJob(seed.projectId, ctx)).resolves.toBe('story');
  });

  it('a project that cannot be read resolves to story rather than throwing', async () => {
    const seed = await seedProject();
    await expect(
      resolvePlanningCadenceForJob('pj_does_not_exist', {
        userId: seed.userId,
        workspaceId: seed.workspaceId,
      }),
    ).resolves.toBe('story');
  });
});

describe('get_project_state — the door plan.py reads the cadence through', () => {
  it('reports story for a never-written project and subtask once saved, in both forms', async () => {
    const seed = await seedProject();
    const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };

    const before = await projectStateService.getProjectState(seed.identifier, ctx);
    expect(before.planningCadence).toBe('story');
    expect(summarizeProjectState(before)).toContain('Planning cadence: story');

    await projectAiSettingsService.updateAiSettings(
      seed.identifier,
      { aiPlanningCadence: 'subtask' },
      ctx,
    );
    const after = await projectStateService.getProjectState(seed.identifier, ctx);
    expect(after.planningCadence).toBe('subtask');
    expect(summarizeProjectState(after)).toContain('Planning cadence: subtask');
  });
});

describe('the setting on the SERIALIZED envelope (the only form motir-ai sees)', () => {
  const tenant = {
    organizationId: 'org_1',
    isMeta: false,
    workspaceId: 'ws_1',
    projectId: 'pj_1',
    projectKey: 'MOTIR',
  };

  beforeEach(() => {
    process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  });

  async function wireContext(value: 'story' | 'subtask'): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'job_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await submitJob(
        'plan',
        tenant,
        { [PLANNING_CADENCE_CONTEXT_FIELD]: value },
        { userId: 'user_1' },
      );
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as { context: Record<string, unknown> };
      return body.context;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('carries story on the wire, present as a key, for a project on today’s walk', async () => {
    const context = await wireContext('story');
    expect(context[WIRE_KEY]).toBe('story');
    expect(Object.prototype.hasOwnProperty.call(context, WIRE_KEY)).toBe(true);
  });

  it('carries subtask on the wire when the project plans one step at a time', async () => {
    const context = await wireContext('subtask');
    expect(context[WIRE_KEY]).toBe('subtask');
  });

  it('the exported constant IS the wire string', () => {
    expect(PLANNING_CADENCE_CONTEXT_FIELD).toBe(WIRE_KEY);
  });
});
