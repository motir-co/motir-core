import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '@/lib/projects';
import type { RawPreplanSession, RawPreplanStateResponse } from '@/lib/ai/types';

// Transport tests for GET /api/ai/pre-plan — the resumable pre-plan read seam
// (Subtask 7.3.70). The COMPANION service test (`ai/aiPreplanService.test.ts`)
// proves the Raw→DTO mapping at the service layer; this file proves the things
// only the ROUTE owns:
//   - the session gate (401 before any service / motir-ai call),
//   - the active-project gate (404, the no-existence-leak shape — finding #26),
//   - the DTO actually serialized back through `NextResponse.json` (route → DTO),
//   - a not-yet-started pre-plan → 200 empty state (NOT an error),
//   - a motir-ai outage → 502 (never a misleading empty).
//
// This route has NO DB read (the service forwards the resolved context's core
// ids straight to the boundary client), so — like board-routes — we stub the two
// context resolvers the test env can't supply (no cookies): `getSession` and
// `getActiveProject`. The motir-ai HTTP client leaf `getPreplanState` is the
// sanctioned boundary mock (an external network call). The route runs through the
// REAL aiPreplanService, so the mapping is exercised end-to-end.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

// MOTIR-3653 / MOTIR-3648 — every route and route group now resolves the 2FA
// hold first. This suite is about this route's own gates, so the policy answers
// "nobody is asking", which is the state each case below was written in.
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('./helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const getPreplanStateMock = vi.fn<(q: unknown) => Promise<RawPreplanStateResponse>>();
const saveDesignChoiceMock = vi.fn<(input: unknown) => Promise<RawPreplanSession>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getPreplanState: (q: unknown) => getPreplanStateMock(q),
  saveDesignChoice: (input: unknown) => saveDesignChoiceMock(input),
}));

// The PATCH service path resolves the active workspace's org id (the write
// find-or-creates the AiProject under it). Stub the RLS tx + the workspace read so
// this stays a transport test (no DB), the same way it stubs the context resolvers.
vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceContext: <T>(_c: unknown, fn: (tx: unknown) => Promise<T>) => fn({}),
}));
vi.mock('@/lib/repositories/workspaceRepository', () => ({
  workspaceRepository: { findByIdInTx: async () => ({ organizationId: 'org_1' }) },
}));
// …and the project gate (MOTIR-2358). These cases drive a SYNTHETIC ProjectContext
// with no rows behind it, so the real assert would 404 on the project id and
// prove nothing about the boundary contract they are here for. The gate is
// covered against real Postgres in `tests/integration/ai/planPermissionGate.test.ts`.
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { assertPermission: vi.fn() },
}));

// Import the handler AFTER the mocks are registered.
const { GET, PATCH } = await import('@/app/api/ai/pre-plan/route');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');

const PROJECT_CTX: ProjectContext = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir' },
} as ProjectContext;

function signIn() {
  session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
}
function withActiveProject() {
  activeCtx.current = PROJECT_CTX;
}

beforeEach(() => {
  session.current = null;
  activeCtx.current = null;
  getPreplanStateMock.mockReset();
  saveDesignChoiceMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/ai/pre-plan', () => {
  it('401s an unauthenticated request before touching the service / motir-ai', async () => {
    const res = await GET();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
    expect(getPreplanStateMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project (the no-existence-leak shape)', async () => {
    signIn();
    const res = await GET();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'NO_ACTIVE_PROJECT',
      error: 'No active project.',
    });
    expect(getPreplanStateMock).not.toHaveBeenCalled();
  });

  it('200s the mapped pre-plan DTO for the active project, resolved by core ids, with a private no-store header', async () => {
    signIn();
    withActiveProject();
    getPreplanStateMock.mockResolvedValue({
      session: {
        aiProjectId: 'aip_internal_1',
        classification: 'startup',
        platform: 'web',
        docSkipSet: [],
        designStarter: 'minimal',
        designChoice: { styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' },
        validationTiming: 'after',
        currentGate: 'vision',
        conversation: [{ role: 'user', content: 'hi' }],
        status: 'active',
        createdAt: '2026-06-19T10:00:00.000Z',
        updatedAt: '2026-06-19T11:00:00.000Z',
      },
      docs: [
        {
          kind: 'discovery',
          currentBody: '# Discovery (Tier 1)\n\n## 1. Audience\n\nFounders.',
          currentVersion: 1,
          summary: [],
          versions: [
            { version: 1, changeReason: null, changeKind: null, diff: null, createdAt: 'iso1' },
          ],
        },
      ],
      catalog: {
        categories: [
          {
            id: 'cat_1',
            title: 'Work Items',
            features: [
              { id: 'f1', name: 'Boards', descriptionMd: 'Kanban', phase: 'mvp', status: 'todo' },
            ],
          },
        ],
        glossary: [],
      },
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    // The route resolved project→aiProject by forwarding the context's core ids.
    expect(getPreplanStateMock).toHaveBeenCalledWith({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
    });
    const body = await res.json();
    expect(body.session.classification).toBe('startup');
    expect(body.session).not.toHaveProperty('aiProjectId'); // internal id not leaked
    // The persisted design choice (7.3.81) rides back to the browser so the design
    // step restores the saved look on resume.
    expect(body.session.designChoice).toEqual({
      styleId: 'soft-playful',
      paletteId: 'cobalt',
      typeId: 'grotesk',
    });
    // Each produced tier's rendered body reaches the browser (the 7.3.5 gate
    // renders it through DirectionDocView) alongside its forward revision log.
    expect(body.docs).toEqual([
      {
        kind: 'discovery',
        currentBody: '# Discovery (Tier 1)\n\n## 1. Audience\n\nFounders.',
        currentVersion: 1,
        summary: [],
        versions: [
          { version: 1, changeReason: null, changeKind: null, diff: null, createdAt: 'iso1' },
        ],
      },
    ]);
    // The folded-into-vision feature catalog reaches the browser too (7.3.79).
    expect(body.catalog.categories[0].title).toBe('Work Items');
    expect(body.catalog.categories[0].features[0].name).toBe('Boards');
  });

  it('200s the empty state for a project that never started a pre-plan (not an error)', async () => {
    signIn();
    withActiveProject();
    getPreplanStateMock.mockResolvedValue({ session: null, docs: [], catalog: null });

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ session: null, docs: [], catalog: null });
  });

  it('502s when motir-ai is unavailable (never a misleading empty)', async () => {
    signIn();
    withActiveProject();
    getPreplanStateMock.mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const res = await GET();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('MOTIR_AI_UNAVAILABLE');
  });
});

describe('PATCH /api/ai/pre-plan (the design-choice write, 7.3.81)', () => {
  // Valid registry ids for each axis (Style × Palette × Type).
  const choice = { styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' };
  const patchReq = (body: unknown): Request =>
    new Request('http://test/api/ai/pre-plan', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('401s an unauthenticated request before touching the service / motir-ai', async () => {
    const res = await PATCH(patchReq({ designChoice: choice }));
    expect(res.status).toBe(401);
    expect(saveDesignChoiceMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project (the no-existence-leak shape)', async () => {
    signIn();
    const res = await PATCH(patchReq({ designChoice: choice }));
    expect(res.status).toBe(404);
    expect(saveDesignChoiceMock).not.toHaveBeenCalled();
  });

  it('400s a malformed body (missing / non-string axes) before any write', async () => {
    signIn();
    withActiveProject();
    const bad = [
      {},
      { designChoice: null },
      { designChoice: { styleId: 'soft-playful' } },
      { designChoice: { styleId: 1, paletteId: 'cobalt', typeId: 'grotesk' } },
    ];
    for (const body of bad) {
      const res = await PATCH(patchReq(body));
      expect(res.status).toBe(400);
    }
    expect(saveDesignChoiceMock).not.toHaveBeenCalled();
  });

  // MOTIR-11607 — the optional per-area backgrounds.
  it('400s a backgrounds that is not three strings, before any write', async () => {
    signIn();
    withActiveProject();
    const bad = [
      'wave',
      null,
      ['wave', 'wave', 'wave'],
      { landing: 'wave', login: 'wave' },
      { landing: 'wave', login: 'wave', hero: 3 },
    ];
    for (const backgrounds of bad) {
      const res = await PATCH(patchReq({ designChoice: { ...choice, backgrounds } }));
      expect(res.status).toBe(400);
    }
    expect(saveDesignChoiceMock).not.toHaveBeenCalled();
  });

  it('422s an unknown background id, naming the area, without writing', async () => {
    signIn();
    withActiveProject();
    const res = await PATCH(
      patchReq({
        designChoice: {
          ...choice,
          backgrounds: { landing: 'wave', login: 'lava-lamp', hero: 'none' },
        },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_DESIGN_CHOICE');
    expect(body.error).toContain('backgrounds.login');
    expect(saveDesignChoiceMock).not.toHaveBeenCalled();
  });

  it('forwards valid backgrounds to motir-ai and echoes them back unchanged', async () => {
    signIn();
    withActiveProject();
    const withBackgrounds = {
      ...choice,
      backgrounds: { landing: 'topography', login: 'none', hero: 'aurora' },
    };
    saveDesignChoiceMock.mockResolvedValue({
      designChoice: withBackgrounds,
    } as unknown as RawPreplanSession);

    const res = await PATCH(patchReq({ designChoice: { ...withBackgrounds, stray: 'x' } }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ designChoice: withBackgrounds });
    expect(saveDesignChoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ designChoice: withBackgrounds }),
    );
  });

  it('422s an unknown axis id (motir-core owns the registries), without writing', async () => {
    signIn();
    withActiveProject();
    const res = await PATCH(patchReq({ designChoice: { ...choice, styleId: 'not-a-style' } }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_DESIGN_CHOICE' });
    expect(saveDesignChoiceMock).not.toHaveBeenCalled();
  });

  it('200s and echoes the persisted choice for a valid pick, forwarding org + bare starter', async () => {
    signIn();
    withActiveProject();
    saveDesignChoiceMock.mockResolvedValue({
      designChoice: choice,
    } as unknown as RawPreplanSession);

    const res = await PATCH(patchReq({ designChoice: choice }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(res.json()).resolves.toEqual({ designChoice: choice });
    expect(saveDesignChoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        coreOrganizationId: 'org_1',
        coreWorkspaceId: 'ws_1',
        coreProjectId: 'pj_1',
        designChoice: choice,
        designStarter: 'bare',
      }),
    );
  });

  it('502s when motir-ai is unavailable (never a silent drop)', async () => {
    signIn();
    withActiveProject();
    saveDesignChoiceMock.mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const res = await PATCH(patchReq({ designChoice: choice }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_UNAVAILABLE' });
  });
});
