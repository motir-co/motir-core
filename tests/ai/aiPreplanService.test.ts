import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client (no network). aiPreplanService is a pure read-through:
// it forwards the already-resolved ProjectContext's core ids to the 7.3.25 client
// primitive and maps the wire body to the motir-core DTO — there is no DB read to
// stub (unlike usage, this read carries no org resolution), so this is a pure
// mapping test in the node env.
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn(), saveDesignChoice: vi.fn() }));
// The write resolves the active workspace's org id (the write find-or-creates the
// AiProject under it). Stub the RLS tx + the workspace read so this stays a pure
// node-env service test (no DB), mirroring the boundary-mock convention above.
vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceContext: <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) => fn({}),
}));
vi.mock('@/lib/repositories/workspaceRepository', () => ({
  workspaceRepository: { findByIdInTx: vi.fn(async () => ({ organizationId: 'org_1' })) },
}));
// …and the project gate (MOTIR-2358). These cases drive a SYNTHETIC ProjectContext
// with no rows behind it, so the real assert would 404 on the project id and
// prove nothing about the boundary contract they are here for. The gate is
// covered against real Postgres in `tests/integration/ai/planPermissionGate.test.ts`.
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { assertPermission: vi.fn() },
}));

import { aiPreplanService } from '@/lib/services/aiPreplanService';
import { getPreplanState, saveDesignChoice } from '@/lib/ai/motirAiClient';
import { InvalidDesignChoiceError } from '@/lib/ai/preplanErrors';
import { toDirectionDocView } from '@/lib/onboarding/directionDoc';
import type { ProjectContext } from '@/lib/projects';
import type { RawPreplanSession, RawPreplanStateResponse } from '@/lib/ai/types';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir' },
} as ProjectContext;

const fullRaw: RawPreplanStateResponse = {
  session: {
    aiProjectId: 'aip_internal_1',
    classification: 'startup',
    platform: 'web',
    docSkipSet: ['feasibility'],
    designStarter: 'minimal',
    designChoice: { styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' },
    validationTiming: 'after',
    currentGate: 'vision',
    conversation: [{ role: 'user', content: 'build me a tracker' }],
    status: 'active',
    createdAt: '2026-06-19T10:00:00.000Z',
    updatedAt: '2026-06-19T11:00:00.000Z',
  },
  docs: [
    {
      kind: 'discovery',
      currentBody: '# Discovery (Tier 1)\n\n## 1. Audience\n\nB2B teams.',
      currentVersion: 2,
      summary: [],
      versions: [
        {
          version: 1,
          changeReason: null,
          changeKind: null,
          diff: null,
          createdAt: '2026-06-19T10:05:00.000Z',
        },
        {
          version: 2,
          changeReason: 'user revised the audience',
          changeKind: 'edit',
          diff: { added: ['B2B'], removed: ['B2C'] },
          createdAt: '2026-06-19T10:30:00.000Z',
        },
      ],
    },
    {
      kind: 'vision',
      currentBody: '# Vision (Tier 2)\n\n## 1. Pitch\n\nThe shape of v1.',
      currentVersion: 1,
      summary: [],
      versions: [
        {
          version: 1,
          changeReason: null,
          changeKind: null,
          diff: null,
          createdAt: '2026-06-19T10:40:00.000Z',
        },
      ],
    },
  ],
  catalog: {
    categories: [
      {
        id: 'cat_1',
        title: 'Work Items',
        features: [
          {
            id: 'feat_1',
            name: 'Boards',
            descriptionMd: 'Kanban + Scrum',
            phase: 'mvp',
            status: 'todo',
          },
          {
            id: 'feat_2',
            name: 'Reports',
            descriptionMd: 'Charts',
            phase: 'v1',
            status: 'in_progress',
          },
        ],
      },
    ],
    glossary: [
      {
        id: 'grp_1',
        title: 'Core',
        concepts: [
          {
            id: 'con_1',
            term: 'Work item',
            aka: 'issue',
            descriptionMd: 'A tracked unit',
            example: 'A bug',
          },
        ],
      },
    ],
  },
};

beforeEach(() => vi.clearAllMocks());

describe('aiPreplanService.getPreplanState', () => {
  it('forwards ONLY the core (workspace, project) ids to the client — never an aiProject id', async () => {
    vi.mocked(getPreplanState).mockResolvedValue({ session: null, docs: [], catalog: null });

    await aiPreplanService.getPreplanState(ctx);

    expect(getPreplanState).toHaveBeenCalledTimes(1);
    expect(getPreplanState).toHaveBeenCalledWith({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
    });
  });

  it('maps a populated session + revision logs to the DTO, dropping the motir-ai-internal aiProjectId', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(fullRaw);

    const dto = await aiPreplanService.getPreplanState(ctx);

    // The 5 strategy decisions + gate + transcript essentials survive…
    expect(dto.session).toEqual({
      classification: 'startup',
      platform: 'web',
      designStarter: 'minimal',
      designChoice: { styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' },
      validationTiming: 'after',
      docSkipSet: ['feasibility'],
      currentGate: 'vision',
      status: 'active',
      conversation: [{ role: 'user', content: 'build me a tracker' }],
      createdAt: '2026-06-19T10:00:00.000Z',
      updatedAt: '2026-06-19T11:00:00.000Z',
    });
    // …and the motir-ai-internal identity is NOT leaked to the browser.
    expect(dto.session).not.toHaveProperty('aiProjectId');
  });

  it('preserves each artifact’s current body + version AND the forward revision log (diffs verbatim)', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(fullRaw);

    const dto = await aiPreplanService.getPreplanState(ctx);

    expect(dto.docs).toEqual([
      {
        kind: 'discovery',
        currentBody: '# Discovery (Tier 1)\n\n## 1. Audience\n\nB2B teams.',
        currentVersion: 2,
        summary: [],
        versions: [
          {
            version: 1,
            changeReason: null,
            changeKind: null,
            diff: null,
            createdAt: '2026-06-19T10:05:00.000Z',
          },
          {
            version: 2,
            changeReason: 'user revised the audience',
            changeKind: 'edit',
            diff: { added: ['B2B'], removed: ['B2C'] },
            createdAt: '2026-06-19T10:30:00.000Z',
          },
        ],
      },
      {
        kind: 'vision',
        currentBody: '# Vision (Tier 2)\n\n## 1. Pitch\n\nThe shape of v1.',
        currentVersion: 1,
        summary: [],
        versions: [
          {
            version: 1,
            changeReason: null,
            changeKind: null,
            diff: null,
            createdAt: '2026-06-19T10:40:00.000Z',
          },
        ],
      },
    ]);
  });

  it('threads each produced tier’s current body + version through to the DTO, mappable to a DirectionDocView', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(fullRaw);

    const dto = await aiPreplanService.getPreplanState(ctx);

    // The body is sourced from the motir-ai wire, never synthesized.
    expect(dto.docs.map((d) => [d.kind, d.currentBody, d.currentVersion])).toEqual([
      ['discovery', '# Discovery (Tier 1)\n\n## 1. Audience\n\nB2B teams.', 2],
      ['vision', '# Vision (Tier 2)\n\n## 1. Pitch\n\nThe shape of v1.', 1],
    ]);
    // …and folds straight onto 834's read-only view model at the 7.3.5 gate.
    // The structured `summary` (MOTIR-1225) is carried through verbatim — `[]`
    // here since this fixture's tiers have no structured findings.
    expect(toDirectionDocView(dto.docs[1]!)).toEqual({
      kind: 'vision',
      contentMd: '# Vision (Tier 2)\n\n## 1. Pitch\n\nThe shape of v1.',
      version: 1,
      summary: [],
    });
  });

  it('maps the structured feature catalog (7.3.78) onto the FeatureCatalogView, keeping per-node ids, dropping motir-ai internals', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(fullRaw);

    const dto = await aiPreplanService.getPreplanState(ctx);

    // Folded-into-vision catalog: categories/features (order + phase + status +
    // ids the render keys on) and the glossary map straight through; the
    // motir-ai-internal catalog id/aiProjectId/timestamps are NOT present.
    expect(dto.catalog).toEqual({
      categories: [
        {
          id: 'cat_1',
          title: 'Work Items',
          features: [
            {
              id: 'feat_1',
              name: 'Boards',
              descriptionMd: 'Kanban + Scrum',
              phase: 'mvp',
              status: 'todo',
            },
            {
              id: 'feat_2',
              name: 'Reports',
              descriptionMd: 'Charts',
              phase: 'v1',
              status: 'in_progress',
            },
          ],
        },
      ],
      glossary: [
        {
          id: 'grp_1',
          title: 'Core',
          concepts: [
            {
              id: 'con_1',
              term: 'Work item',
              aka: 'issue',
              descriptionMd: 'A tracked unit',
              example: 'A bug',
            },
          ],
        },
      ],
    });
    expect(dto.catalog).not.toHaveProperty('aiProjectId');
    expect(dto.catalog).not.toHaveProperty('id');
  });

  it('passes the empty resume state through as session: null / docs: [] / catalog: null (a not-yet-started project, not an error)', async () => {
    vi.mocked(getPreplanState).mockResolvedValue({ session: null, docs: [], catalog: null });

    const dto = await aiPreplanService.getPreplanState(ctx);

    expect(dto).toEqual({ session: null, docs: [], catalog: null });
  });

  it('passes a null catalog through (tiers produced before the vision step drafts the catalog)', async () => {
    vi.mocked(getPreplanState).mockResolvedValue({ ...fullRaw, catalog: null });

    const dto = await aiPreplanService.getPreplanState(ctx);

    expect(dto.catalog).toBeNull();
    expect(dto.docs).toHaveLength(2); // docs still threaded
  });

  it('propagates a client transport error (the route maps it to 502)', async () => {
    vi.mocked(getPreplanState).mockRejectedValue(new Error('boom'));

    await expect(aiPreplanService.getPreplanState(ctx)).rejects.toThrow('boom');
  });

  it('maps stored backgrounds through, and leaves them off a choice saved without them', async () => {
    const backgrounds = { landing: 'aurora', login: 'none', hero: 'wave' };
    vi.mocked(getPreplanState).mockResolvedValue({
      ...fullRaw,
      session: {
        ...fullRaw.session!,
        designChoice: { ...fullRaw.session!.designChoice!, backgrounds },
      },
    });
    expect(
      (await aiPreplanService.getPreplanState(ctx)).session?.designChoice?.backgrounds,
    ).toEqual(backgrounds);

    vi.mocked(getPreplanState).mockResolvedValue(fullRaw);
    const legacy = (await aiPreplanService.getPreplanState(ctx)).session?.designChoice;
    expect(legacy).toEqual({ styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' });
    expect(legacy).not.toHaveProperty('backgrounds');
  });

  it('maps a null designChoice through (the user never picked a design)', async () => {
    vi.mocked(getPreplanState).mockResolvedValue({
      ...fullRaw,
      session: { ...fullRaw.session!, designChoice: null },
    });

    const dto = await aiPreplanService.getPreplanState(ctx);

    expect(dto.session?.designChoice).toBeNull();
  });
});

describe('aiPreplanService.saveDesignChoice (7.3.81)', () => {
  // Valid registry ids for each axis (Style × Palette × Type).
  const choice = { styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' };
  const echoed = (c: typeof choice): RawPreplanSession =>
    ({ designChoice: c }) as unknown as RawPreplanSession;

  it('validates the axes, resolves the org id, and forwards with the bare starter flag', async () => {
    vi.mocked(saveDesignChoice).mockResolvedValue(echoed(choice));

    const result = await aiPreplanService.saveDesignChoice(ctx, choice);

    expect(saveDesignChoice).toHaveBeenCalledWith({
      coreOrganizationId: 'org_1',
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      designChoice: { styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' },
      designStarter: 'bare',
    });
    // Returns the choice echoed back by motir-ai (mapped to the DTO).
    expect(result).toEqual(choice);
  });

  it('falls back to the validated choice if motir-ai omits it from the echo', async () => {
    vi.mocked(saveDesignChoice).mockResolvedValue({ designChoice: null } as RawPreplanSession);

    const result = await aiPreplanService.saveDesignChoice(ctx, choice);

    expect(result).toEqual(choice);
  });

  // MOTIR-11607 — backgrounds per page area, validated against the package registry.
  it('validates and forwards backgrounds per area, and maps them back', async () => {
    const withBackgrounds = {
      ...choice,
      backgrounds: { landing: 'wave', login: 'none', hero: 'brian' },
    };
    vi.mocked(saveDesignChoice).mockResolvedValue({
      designChoice: withBackgrounds,
    } as unknown as RawPreplanSession);

    const result = await aiPreplanService.saveDesignChoice(ctx, withBackgrounds);

    expect(saveDesignChoice).toHaveBeenCalledWith(
      expect.objectContaining({ designChoice: withBackgrounds }),
    );
    expect(result).toEqual(withBackgrounds);
  });

  it.each(['landing', 'login', 'hero'] as const)(
    'rejects an unknown %s background before any write',
    async (area) => {
      const backgrounds = { landing: 'wave', login: 'wave', hero: 'wave', [area]: 'lava-lamp' };
      await expect(
        aiPreplanService.saveDesignChoice(ctx, { ...choice, backgrounds }),
      ).rejects.toMatchObject({ axis: `backgrounds.${area}`, value: 'lava-lamp' });
      expect(saveDesignChoice).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['styleId', { ...choice, styleId: 'not-a-style' }],
    ['paletteId', { ...choice, paletteId: 'not-a-palette' }],
    ['typeId', { ...choice, typeId: 'not-a-type' }],
  ])('rejects an unknown %s with InvalidDesignChoiceError before any write', async (_axis, bad) => {
    await expect(aiPreplanService.saveDesignChoice(ctx, bad)).rejects.toBeInstanceOf(
      InvalidDesignChoiceError,
    );
    // Validation runs FIRST — no org resolution, no upstream write.
    expect(saveDesignChoice).not.toHaveBeenCalled();
  });
});
