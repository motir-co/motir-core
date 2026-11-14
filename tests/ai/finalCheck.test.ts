import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The PRODUCER seam of the final-check setting (Story MOTIR-11262 · MOTIR-11264):
// the project's setting reaches motir-ai on the plan job envelope's `context`,
// because motir-ai cannot read motir-core's database. Real Postgres (the
// motir-core convention), the shape of `tests/ai/lessonCapture.test.ts`:
//
//   1. The stored NULL (never written) resolves to ON at submit time, so a
//      project nobody has touched keeps its final check.
//   2. An explicit `false` reaches the envelope as `false` and is PRESENT —
//      absent and false are opposite answers across this boundary.
//   3. The assertion is made on the SERIALIZED body, the only form motir-ai sees.

import { db } from '@/lib/db';
import { FINAL_CHECK_CONTEXT_FIELD, resolveFinalCheckForJob } from '@/lib/ai/finalCheck';
import { AI_FINAL_CHECK_DEFAULT, resolveFinalCheck } from '@/lib/projectAiSettings/limits';
import { submitJob } from '@/lib/ai/motirAiClient';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// The WIRE STRING, written out rather than imported from the code under test:
// motir-ai reads this same literal (MOTIR-11265), and a test that read the name
// out of the module would agree with itself and prove nothing about the contract.
const WIRE_KEY = 'finalCheck';

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
    email: `final-check-${randomToken(6)}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const identifier = `FC${randomToken(4)
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

describe('resolveFinalCheck — the one place the default lives', () => {
  it('reads an unset column as ON and an explicit value as itself', () => {
    expect(AI_FINAL_CHECK_DEFAULT).toBe(true);
    expect(resolveFinalCheck(null)).toBe(true);
    expect(resolveFinalCheck(undefined)).toBe(true);
    expect(resolveFinalCheck(false)).toBe(false);
    expect(resolveFinalCheck(true)).toBe(true);
  });
});

describe('resolveFinalCheckForJob — the setting, resolved at submit time', () => {
  it('a project that has never touched the setting resolves to ON', async () => {
    const seed = await seedProject();

    // The state every project that predates the column is in — asserted on the
    // row, so this is the real unset case and not a written `true`.
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: seed.projectId } });
    expect(row.aiFinalCheck).toBeNull();

    await expect(
      resolveFinalCheckForJob(seed.projectId, {
        userId: seed.userId,
        workspaceId: seed.workspaceId,
      }),
    ).resolves.toBe(true);
  });

  it('an explicit false resolves to false, and turning it back on resolves to true', async () => {
    const seed = await seedProject();
    const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };

    await projectAiSettingsService.updateAiSettings(seed.identifier, { aiFinalCheck: false }, ctx);
    await expect(resolveFinalCheckForJob(seed.projectId, ctx)).resolves.toBe(false);

    await projectAiSettingsService.updateAiSettings(seed.identifier, { aiFinalCheck: true }, ctx);
    await expect(resolveFinalCheckForJob(seed.projectId, ctx)).resolves.toBe(true);
  });

  it('a project that cannot be read resolves to ON rather than throwing', async () => {
    const seed = await seedProject();
    await expect(
      resolveFinalCheckForJob('pj_does_not_exist', {
        userId: seed.userId,
        workspaceId: seed.workspaceId,
      }),
    ).resolves.toBe(true);
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

  async function wireContext(value: boolean): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: 'job_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await submitJob('plan', tenant, { [FINAL_CHECK_CONTEXT_FIELD]: value }, { userId: 'user_1' });
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        envelopeVersion: string;
        context: Record<string, unknown>;
      };
      expect(body.envelopeVersion).toBe('v1');
      return body.context;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('carries `false` on the wire, present as a key, when the project turned it off', async () => {
    const context = await wireContext(false);
    expect(context[WIRE_KEY]).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(context, WIRE_KEY)).toBe(true);
  });

  it('carries `true` on the wire when the final check is on', async () => {
    const context = await wireContext(true);
    expect(context[WIRE_KEY]).toBe(true);
  });

  it('the exported constant IS the wire string', () => {
    expect(FINAL_CHECK_CONTEXT_FIELD).toBe(WIRE_KEY);
  });
});
