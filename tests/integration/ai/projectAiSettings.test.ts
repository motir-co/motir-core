import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectsService } from '@/lib/services/projectsService';
import { toProjectAiSettingsDto } from '@/lib/mappers/projectAiSettingsMappers';
import {
  InvalidAiSettingsError,
  PermissionDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import {
  AI_AUTO_PLAN_THRESHOLD_MAX,
  AI_AUTO_PLAN_THRESHOLD_MIN,
  AI_SPRINT_LENGTH_DAYS_MAX,
  AI_SPRINT_LENGTH_DAYS_MIN,
} from '@/lib/projectAiSettings/limits';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { createTestWorkspace } from '../../fixtures/workspaceFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Story 7.13 · Subtask MOTIR-915 — the `Project` AI-settings columns and the
// 4-layer path over them (migration → projectRepository → projectAiSettingsService
// → DTO/mapper). Real Postgres, no mocks (CLAUDE.md).
//
// What these lock:
//   * the DEFAULTS every existing project backfills to — the feature is OFF
//     (`aiAutoPlanEnabled` / `aiSprintPlanningEnabled` false, threshold 5, sprint
//      length 2 days);
//   * the partial-patch write path (an absent field is untouched) through the
//     repository;
//   * the RETIRED planner-model column (MOTIR-7228): still in the database, and
//     nothing in the settings path reads or writes it — a stale patch naming it
//     is ignored;
//   * APP-SIDE validation — an out-of-range / fractional value is REJECTED with a
//     typed error and NOTHING is written, never silently clamped at the DB;
//   * the tenancy + admin gates (no existence leak on a foreign key; a non-admin
//     cannot change the cadence).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The settings fixture: an owner (project admin) + a project. */
async function makeFixture(opts: { name?: string; identifier?: string } = {}) {
  return makeWorkItemFixture({ name: opts.name ?? 'Acme', identifier: opts.identifier ?? 'PROD' });
}

/** The workspace-scoped context the settings service takes. */
function ctxFor(fx: WorkItemFixture, userId = fx.ownerId) {
  return { userId, workspaceId: fx.workspaceId };
}

describe('Project AI-settings columns — defaults (MOTIR-915)', () => {
  it('a freshly created project backfills to the safe defaults: the feature is OFF', async () => {
    const fx = await makeFixture();

    const settings = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));

    expect(settings).toEqual({
      aiAutoPlanEnabled: false,
      aiAutoPlanThreshold: 5,
      aiSprintPlanningEnabled: false,
      aiSprintLengthDays: 2,
      aiGenerateExplanations: false,
      // ON, and NOT because a default was written to the row — the column is
      // NULL on a fresh project and the mapper resolves it (MOTIR-3349).
      aiRecordPlanningMistakes: true,
      // ON the same way: a NULL column the mapper resolves (MOTIR-11264).
      aiFinalCheck: true,
    });
  });

  it('the columns exist on the row itself with those DB-level defaults (the migration, not the service)', async () => {
    const fx = await makeFixture();

    // Read the raw row: proves the DEFAULTs live in the migration, so a project
    // created by any path (seed, import, raw insert) backfills the same way.
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });

    expect(row.aiAutoPlanEnabled).toBe(false);
    expect(row.aiAutoPlanThreshold).toBe(5);
    expect(row.aiSprintPlanningEnabled).toBe(false);
    expect(row.aiSprintLengthDays).toBe(2);
    // MOTIR-3349: deliberately NULL on the row. This is the assertion that
    // distinguishes "unset" from "written true" — the migration adds no default,
    // so a project that never touches the setting stores nothing at all.
    expect(row.aiRecordPlanningMistakes).toBeNull();
    // MOTIR-11264: NULL on the row too, for the same reason.
    expect(row.aiFinalCheck).toBeNull();
  });

  it('the mapper projects the row (and the repository projection) to the same DTO', async () => {
    const fx = await makeFixture();
    const projection = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      projectRepository.findAiSettings(fx.projectId, tx),
    );
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });

    expect(projection).not.toBeNull();
    expect(toProjectAiSettingsDto(projection!)).toEqual(toProjectAiSettingsDto(row));
  });
});

describe('projectAiSettingsService.updateAiSettings — the write path', () => {
  it('persists every field through the repository and returns the updated DTO', async () => {
    const fx = await makeFixture();

    const updated = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      {
        aiAutoPlanEnabled: true,
        aiAutoPlanThreshold: 3,
        aiSprintPlanningEnabled: true,
        aiSprintLengthDays: 7,
        aiGenerateExplanations: true,
        aiRecordPlanningMistakes: false,
        aiFinalCheck: false,
      },
      ctxFor(fx),
    );

    expect(updated).toEqual({
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 3,
      aiSprintPlanningEnabled: true,
      aiSprintLengthDays: 7,
      aiGenerateExplanations: true,
      aiRecordPlanningMistakes: false,
      aiFinalCheck: false,
    });
    // Committed, not just returned.
    const reread = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(reread).toEqual(updated);
  });

  it('is a PARTIAL patch — an absent field is left untouched', async () => {
    const fx = await makeFixture();
    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiAutoPlanEnabled: true, aiAutoPlanThreshold: 9, aiGenerateExplanations: true },
      ctxFor(fx),
    );

    const after = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiSprintPlanningEnabled: true },
      ctxFor(fx),
    );

    expect(after.aiSprintPlanningEnabled).toBe(true);
    expect(after.aiAutoPlanEnabled).toBe(true);
    expect(after.aiAutoPlanThreshold).toBe(9);
    expect(after.aiGenerateExplanations).toBe(true);
  });

  // ── MOTIR-3349 · the record-planning-mistakes switch ────────────────────────

  it('a row that PREDATES the column reads as ON — the unset state, constructed', async () => {
    const fx = await makeFixture();

    // The point of the nullable column: a project created before this shipped
    // stores NULL, because the migration adds no default and backfills nothing.
    // Force that exact state rather than trusting that a fresh project has it.
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { aiRecordPlanningMistakes: null },
    });

    const settings = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(settings.aiRecordPlanningMistakes).toBe(true);
  });

  it('only an explicit false switches it off, and the off state is distinguishable from unset', async () => {
    const fx = await makeFixture();

    const off = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiRecordPlanningMistakes: false },
      ctxFor(fx),
    );
    expect(off.aiRecordPlanningMistakes).toBe(false);

    // On the ROW the two states are different values, which is what lets the
    // consumer tell "this project switched it off" from "nobody ever touched
    // this" — a distinction a NOT NULL DEFAULT column cannot express.
    const offRow = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(offRow.aiRecordPlanningMistakes).toBe(false);

    const backOn = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiRecordPlanningMistakes: true },
      ctxFor(fx),
    );
    expect(backOn.aiRecordPlanningMistakes).toBe(true);
  });

  it('saving ANOTHER field in the group leaves the column untouched — it does not acquire a written true', async () => {
    const fx = await makeFixture();

    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiSprintLengthDays: 4 },
      ctxFor(fx),
    );

    // Still NULL: the sparse patch wrote only the field it was given, and the
    // "unset reads as ON" rule lives on the read path, not the write path. If
    // this ever becomes `true`, a later `false` would be indistinguishable from
    // a deliberate opt-out at the row level.
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.aiRecordPlanningMistakes).toBeNull();

    const settings = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(settings.aiSprintLengthDays).toBe(4);
    expect(settings.aiRecordPlanningMistakes).toBe(true);
  });

  it('an explicit false SURVIVES a later patch of another field (sparse, both directions)', async () => {
    const fx = await makeFixture();

    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiRecordPlanningMistakes: false },
      ctxFor(fx),
    );
    const after = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiAutoPlanEnabled: true },
      ctxFor(fx),
    );

    expect(after.aiAutoPlanEnabled).toBe(true);
    expect(after.aiRecordPlanningMistakes).toBe(false);
  });

  // ── MOTIR-11264 · the final-check switch ──────────────────────────────────────

  it('the final check: a row that predates the column reads as ON', async () => {
    const fx = await makeFixture();
    await adminDb.project.update({ where: { id: fx.projectId }, data: { aiFinalCheck: null } });

    const settings = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(settings.aiFinalCheck).toBe(true);
  });

  it('the final check: an explicit false turns it off, back on reads true, and another field leaves it alone', async () => {
    const fx = await makeFixture();

    // Another field first: the column stays NULL rather than acquiring a true.
    await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiSprintLengthDays: 4 },
      ctxFor(fx),
    );
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } })).aiFinalCheck,
    ).toBeNull();

    const off = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiFinalCheck: false },
      ctxFor(fx),
    );
    expect(off.aiFinalCheck).toBe(false);
    expect(
      (await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } })).aiFinalCheck,
    ).toBe(false);

    // An explicit false survives a later patch of another field.
    const still = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiAutoPlanEnabled: true },
      ctxFor(fx),
    );
    expect(still.aiFinalCheck).toBe(false);

    const backOn = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      { aiFinalCheck: true },
      ctxFor(fx),
    );
    expect(backOn.aiFinalCheck).toBe(true);
  });

  it('accepts the bound VALUES themselves (the range is inclusive)', async () => {
    const fx = await makeFixture();

    const low = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      {
        aiAutoPlanThreshold: AI_AUTO_PLAN_THRESHOLD_MIN,
        aiSprintLengthDays: AI_SPRINT_LENGTH_DAYS_MIN,
      },
      ctxFor(fx),
    );
    expect(low.aiAutoPlanThreshold).toBe(AI_AUTO_PLAN_THRESHOLD_MIN);
    expect(low.aiSprintLengthDays).toBe(AI_SPRINT_LENGTH_DAYS_MIN);

    const high = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      {
        aiAutoPlanThreshold: AI_AUTO_PLAN_THRESHOLD_MAX,
        aiSprintLengthDays: AI_SPRINT_LENGTH_DAYS_MAX,
      },
      ctxFor(fx),
    );
    expect(high.aiAutoPlanThreshold).toBe(AI_AUTO_PLAN_THRESHOLD_MAX);
    expect(high.aiSprintLengthDays).toBe(AI_SPRINT_LENGTH_DAYS_MAX);
  });
});

describe('projectAiSettingsService.updateAiSettings — app-side validation (rejected, never clamped)', () => {
  it('rejects a threshold below 1 and writes NOTHING', async () => {
    const fx = await makeFixture();

    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiAutoPlanEnabled: true, aiAutoPlanThreshold: 0 },
        ctxFor(fx),
      ),
    ).rejects.toBeInstanceOf(InvalidAiSettingsError);

    // The whole patch is rejected — the sibling toggle in the same call did not land.
    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiAutoPlanThreshold).toBe(5);
    expect(after.aiAutoPlanEnabled).toBe(false);
  });

  it('rejects a negative threshold, a fractional threshold, and one over the max', async () => {
    const fx = await makeFixture();
    for (const value of [-1, 2.5, AI_AUTO_PLAN_THRESHOLD_MAX + 1, Number.NaN]) {
      const err = await projectAiSettingsService
        .updateAiSettings(fx.projectIdentifier, { aiAutoPlanThreshold: value }, ctxFor(fx))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidAiSettingsError);
      expect((err as InvalidAiSettingsError).field).toBe('aiAutoPlanThreshold');
    }
    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiAutoPlanThreshold).toBe(5);
  });

  it('rejects a sprint length outside 1..14 (and a fractional one)', async () => {
    const fx = await makeFixture();
    for (const value of [AI_SPRINT_LENGTH_DAYS_MIN - 1, AI_SPRINT_LENGTH_DAYS_MAX + 1, 1.5, -3]) {
      const err = await projectAiSettingsService
        .updateAiSettings(fx.projectIdentifier, { aiSprintLengthDays: value }, ctxFor(fx))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidAiSettingsError);
      expect((err as InvalidAiSettingsError).field).toBe('aiSprintLengthDays');
    }
    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiSprintLengthDays).toBe(2);
  });

  it('the route layer maps the typed error to 422 with its field', async () => {
    const res = projectErrorResponse(
      new InvalidAiSettingsError('aiSprintLengthDays', 'The AI sprint length (days) must be…'),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(422);
    await expect(res!.json()).resolves.toMatchObject({
      code: 'INVALID_AI_SETTINGS',
      field: 'aiSprintLengthDays',
    });
  });
});

describe('projectAiSettingsService — tenancy + admin gates', () => {
  it('a key from ANOTHER workspace reads as not-found (no existence leak)', async () => {
    const mine = await makeFixture({ name: 'Mine', identifier: 'MINE' });
    const theirs = await makeFixture({ name: 'Theirs', identifier: 'THRS' });

    await expect(
      projectAiSettingsService.getAiSettings(theirs.projectIdentifier, ctxFor(mine)),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      projectAiSettingsService.updateAiSettings(
        theirs.projectIdentifier,
        { aiAutoPlanEnabled: true },
        ctxFor(mine),
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    const untouched = await projectAiSettingsService.getAiSettings(
      theirs.projectIdentifier,
      ctxFor(theirs),
    );
    expect(untouched.aiAutoPlanEnabled).toBe(false);
  });

  it('a never-existed key reads as not-found', async () => {
    const fx = await makeFixture();
    await expect(projectAiSettingsService.getAiSettings('NOPE', ctxFor(fx))).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('a plain workspace member can READ the settings but cannot CHANGE them', async () => {
    const fx = await makeFixture();
    const member = await createTestUser({ email: 'member@example.com' });
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });

    // Browse-scoped read: an ordinary member sees the configuration.
    const read = await projectAiSettingsService.getAiSettings(
      fx.projectIdentifier,
      ctxFor(fx, member.id),
    );
    expect(read.aiAutoPlanEnabled).toBe(false);

    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiAutoPlanEnabled: true },
        ctxFor(fx, member.id),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // MOTIR-3349: the SAME gate covers the new field — it is refused by the one
    // `ai:configure` assert the service already makes, and no second gate was
    // introduced for it. A member must not be able to switch off the recording
    // of this project's planning mistakes.
    expect(read.aiRecordPlanningMistakes).toBe(true);
    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiRecordPlanningMistakes: false },
        ctxFor(fx, member.id),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // MOTIR-11264: and the final check — a member cannot turn it off either.
    expect(read.aiFinalCheck).toBe(true);
    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiFinalCheck: false },
        ctxFor(fx, member.id),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const after = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(after.aiAutoPlanEnabled).toBe(false);
    expect(after.aiRecordPlanningMistakes).toBe(true);
    expect(after.aiFinalCheck).toBe(true);
  });

  it('names `ai:configure` on the refusal — not the umbrella, and not `ai:plan`', async () => {
    // MOTIR-2300. The write moved from `assertCanManage` to
    // `assertPermission(…, 'ai:configure')`, so the refusal carries the KEY.
    // Behaviour is unchanged for every actor — `ai:configure` resolves exactly
    // as `project:administer` does, proved over all 64 inputs in
    // accessParity.test.ts — but the 403 now says WHICH grant is missing, and
    // the key it names is the settings one. `ai:plan` (who may RUN the planner)
    // is MOTIR-2291's, governed by nothing today, and must not appear here.
    const fx = await makeFixture();
    const member = await createTestUser({ email: 'ai-key-member@example.com' });
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });

    const err = await projectAiSettingsService
      .updateAiSettings(
        fx.projectIdentifier,
        { aiGenerateExplanations: true },
        ctxFor(fx, member.id),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('ai:configure');
    expect((err as PermissionDeniedError).code).toBe('PERMISSION_DENIED');
  });

  it('a NON-BROWSER gets 404, not 403 — the settings surface stays hidden', async () => {
    // The 404-before-403 ordering `assertPermission` inherited from
    // `assertCanManage`: an actor who cannot browse the project must not learn
    // it exists from a permission error.
    const fx = await makeFixture();
    const outsider = await createTestUser({ email: 'ai-outsider@example.com' });
    await expect(
      projectAiSettingsService.updateAiSettings(
        fx.projectIdentifier,
        { aiAutoPlanEnabled: true },
        ctxFor(fx, outsider.id),
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('settings are per-project: changing one project leaves its sibling on the defaults', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Two projects' });
    const a = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Alpha',
      identifier: 'ALPH',
    });
    const b = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Beta',
      identifier: 'BETA',
    });
    const ctx = { userId: owner.id, workspaceId: workspace.id };

    await projectAiSettingsService.updateAiSettings(
      a.identifier,
      { aiAutoPlanEnabled: true, aiSprintLengthDays: 5 },
      ctx,
    );

    expect(await projectAiSettingsService.getAiSettings(b.identifier, ctx)).toMatchObject({
      aiAutoPlanEnabled: false,
      aiSprintLengthDays: 2,
    });
  });
});

describe('the retired planner-model column (MOTIR-7228 · dropped by MOTIR-7233)', () => {
  // The three-release removal is complete: MOTIR-7228 stopped every reader and
  // `@ignore`d the field, MOTIR-7230 verified that build was serving, and
  // MOTIR-7233 dropped the column. These pin the end state: it is gone, and a
  // client that still sends the key saves the rest of its patch.
  async function plannerModelColumnCount(): Promise<number> {
    const rows = await adminDb.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'project'
          AND column_name = 'ai_planner_model'`,
    );
    return rows[0]!.n;
  }

  it('the column is gone, and the DTO carries no planner-model key', async () => {
    const fx = await makeFixture();
    expect(await plannerModelColumnCount()).toBe(0);

    const settings = await projectAiSettingsService.getAiSettings(fx.projectIdentifier, ctxFor(fx));
    expect(Object.keys(settings).some((k) => /model/i.test(k))).toBe(false);
  });

  it('a stale patch naming it saves the rest', async () => {
    const fx = await makeFixture();
    // A client built before the retirement still sends the key: TypeScript no
    // longer allows it, so the cast is the shape of that request at runtime.
    const stale = { aiPlannerModel: 'x', aiSprintLengthDays: 5 } as unknown as Parameters<
      typeof projectAiSettingsService.updateAiSettings
    >[1];

    const updated = await projectAiSettingsService.updateAiSettings(
      fx.projectIdentifier,
      stale,
      ctxFor(fx),
    );

    expect(updated.aiSprintLengthDays).toBe(5);
    expect(updated).not.toHaveProperty('aiPlannerModel');
  });
});
