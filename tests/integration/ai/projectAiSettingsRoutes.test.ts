import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';

import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// GET / PATCH /api/projects/[key]/ai-settings — the HTTP surface the AI-planning
// settings panel consumes (Story 7.13 · Subtask MOTIR-919). Real Postgres; every
// read/write runs the real route → projectAiSettingsService → projectRepository
// → Prisma chain (the service's own validation + gate semantics are covered in
// `projectAiSettings.test.ts`; these tests assert the TRANSPORT contract this
// route owns):
//   * the session gate (401 with no workspace context),
//   * the partial-patch forwarding — an ABSENT field is untouched, and a
//     FALSY-but-present one (`false` / `null`) is forwarded, not dropped,
//   * the typed-error → status mapping, incl. the 422 carrying `field` so the
//     panel can slot the message under the offending control,
//   * the no-existence-leak 404 on a cross-workspace / unknown key.
//
// Only `getWorkspaceContext` is stubbed — the session+active-workspace resolver
// the test env can't supply (no cookies). The mock is PARTIAL (importOriginal),
// so the real `withWorkspaceContext` (the RLS-binding transaction every service
// call depends on) is preserved.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

// Import the handlers AFTER the mock is registered.
const { GET, PATCH } = await import('@/app/api/projects/[key]/ai-settings/route');
const { projectAiSettingsService } = await import('@/lib/services/projectAiSettingsService');

const BASE = 'http://localhost:3000/api/projects';

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function signInAs(fx: WorkItemFixture, userId = fx.ownerId) {
  ctxRef.current = { userId, workspaceId: fx.workspaceId };
}

function routeParams(key: string) {
  return { params: Promise.resolve({ key }) };
}

function get(key: string) {
  return GET(new Request(`${BASE}/${key}/ai-settings`), routeParams(key));
}

function patch(key: string, body: unknown) {
  return PATCH(
    new Request(`${BASE}/${key}/ai-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    routeParams(key),
  );
}

describe('GET /api/projects/[key]/ai-settings', () => {
  it('401s with no workspace context', async () => {
    const res = await get('PROD');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('returns the project’s AI settings — the safe OFF defaults for a fresh project', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await get(fx.projectIdentifier);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      aiAutoPlanEnabled: false,
      aiAutoPlanThreshold: 5,
      aiSprintPlanningEnabled: false,
      aiSprintLengthDays: 2,
      aiGenerateExplanations: false,
      // MOTIR-3349 — the one field that is ON by default, resolved from a NULL
      // column rather than written to the row.
      aiRecordPlanningMistakes: true,
      // MOTIR-11264 — ON by default the same way.
      aiFinalCheck: true,
    });
  });

  it('404s (no existence leak) for an unknown key and for another workspace’s project', async () => {
    const mine = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    signInAs(mine);

    const unknown = await get('NOPE');
    expect(unknown.status).toBe(404);

    const foreign = await get(theirs.projectIdentifier);
    expect(foreign.status).toBe(404);
  });
});

describe('PATCH /api/projects/[key]/ai-settings', () => {
  it('401s with no workspace context', async () => {
    const res = await patch('PROD', { aiAutoPlanEnabled: true });
    expect(res.status).toBe(401);
  });

  it('400s on a non-JSON body', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await PATCH(
      new Request(`${BASE}/PROD/ai-settings`, { method: 'PATCH', body: 'not json' }),
      routeParams(fx.projectIdentifier),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('persists the whole panel and returns the updated settings', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const res = await patch(fx.projectIdentifier, {
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 8,
      aiSprintPlanningEnabled: true,
      aiSprintLengthDays: 3,
      aiGenerateExplanations: true,
      aiRecordPlanningMistakes: false,
      aiFinalCheck: false,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 8,
      aiSprintPlanningEnabled: true,
      aiSprintLengthDays: 3,
      aiGenerateExplanations: true,
      aiRecordPlanningMistakes: false,
      aiFinalCheck: false,
    });

    // Read back through the service — the write really landed on the columns.
    const persisted = await projectAiSettingsService.getAiSettings(
      fx.projectIdentifier,
      ctxRef.current!,
    );
    expect(persisted.aiAutoPlanThreshold).toBe(8);
  });

  it('IGNORES the retired planner model — a stale client still saves the rest (MOTIR-7228)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    // A build from before the retirement still sends the key. The route names
    // only the fields it forwards, so the key is dropped — never a 400 — and the
    // rest of the patch lands.
    const res = await patch(fx.projectIdentifier, { aiPlannerModel: 'x', aiSprintLengthDays: 5 });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.aiSprintLengthDays).toBe(5);
    expect(body).not.toHaveProperty('aiPlannerModel');
    const persisted = await projectAiSettingsService.getAiSettings(
      fx.projectIdentifier,
      ctxRef.current!,
    );
    expect(persisted.aiSprintLengthDays).toBe(5);
  });

  it('forwards a PRESENT-but-falsy field (`false` / `null`) instead of dropping it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);
    await patch(fx.projectIdentifier, {
      aiAutoPlanEnabled: true,
      aiGenerateExplanations: true,
    });

    // The panel's "turn it back off" save: a `in`-keyed forward is what makes this reach the service at all.
    const res = await patch(fx.projectIdentifier, {
      aiAutoPlanEnabled: false,
      aiGenerateExplanations: false,
      // MOTIR-3349: this field's OFF value is `false`, and its default is `true`
      // — so a route that dropped falsy keys would make switching it off a
      // silent no-op, the one direction that matters here.
      aiRecordPlanningMistakes: false,
      // MOTIR-11264: the same — off is `false`, the default is `true`.
      aiFinalCheck: false,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      aiAutoPlanEnabled: false,
      aiGenerateExplanations: false,
      aiRecordPlanningMistakes: false,
      aiFinalCheck: false,
    });
  });

  it('is a PARTIAL patch — an ABSENT field is left untouched', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);
    await patch(fx.projectIdentifier, { aiAutoPlanThreshold: 9, aiSprintLengthDays: 7 });

    const res = await patch(fx.projectIdentifier, { aiSprintLengthDays: 4 });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      aiAutoPlanThreshold: 9, // untouched by the second patch
      aiSprintLengthDays: 4,
    });
  });

  it('422s an out-of-range value and NAMES the field (so the panel slots the message)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    signInAs(fx);

    const belowFloor = await patch(fx.projectIdentifier, { aiAutoPlanThreshold: 0 });
    expect(belowFloor.status).toBe(422);
    await expect(belowFloor.json()).resolves.toMatchObject({
      field: 'aiAutoPlanThreshold',
      error: expect.stringContaining('between'),
    });

    const tooLong = await patch(fx.projectIdentifier, { aiSprintLengthDays: 30 });
    expect(tooLong.status).toBe(422);
    await expect(tooLong.json()).resolves.toMatchObject({ field: 'aiSprintLengthDays' });

    // Nothing was written by either rejected patch.
    const settings = await projectAiSettingsService.getAiSettings(
      fx.projectIdentifier,
      ctxRef.current!,
    );
    expect(settings).toMatchObject({
      aiAutoPlanThreshold: 5,
      aiSprintLengthDays: 2,
    });
  });

  it('403s a plain member’s write while still letting them READ (the read-only panel)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const member = await createTestUser({ email: 'member-ai-settings@example.com' });
    await adminDb.workspaceMembership.create({
      data: {
        userId: member.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    signInAs(fx, member.id);

    const read = await get(fx.projectIdentifier);
    expect(read.status).toBe(200);

    const write = await patch(fx.projectIdentifier, { aiAutoPlanEnabled: true });
    expect(write.status).toBe(403);
  });

  it('404s a cross-workspace key (no existence leak on the write path either)', async () => {
    const mine = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    signInAs(mine);

    const res = await patch(theirs.projectIdentifier, { aiAutoPlanEnabled: true });
    expect(res.status).toBe(404);
  });
});
