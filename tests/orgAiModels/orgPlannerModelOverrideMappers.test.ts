import { describe, expect, it } from 'vitest';
import type { OrgPlannerModelOverridesRead } from '@/lib/ai/types';
import { isOrgPlannerFunction, ORG_PLANNER_FUNCTIONS } from '@/lib/dto/orgAiModels';
import {
  toOrgPlannerModelsDTO,
  toOrgPlannerModelWriteDTO,
  UNREADABLE_ORG_PLANNER_MODELS,
} from '@/lib/mappers/orgAiModelsMappers';

// MOTIR-10845 — motir-ai's org override answer → the room's DTO. Pure; the route
// suite drives the same mapper end to end.

const read = (over: Partial<OrgPlannerModelOverridesRead> = {}): OrgPlannerModelOverridesRead => ({
  known: true,
  qualifies: true,
  overrides: [
    {
      function: 'guide',
      model: 'm-guide',
      offered: true,
      applies: true,
      updatedAt: '2026-11-10T00:00:00.000Z',
      updatedByCoreUserId: 'u',
    },
  ],
  effective: [{ function: 'guide', model: 'm-guide', source: 'org' }],
  offered: [{ id: 'm-guide', provider: 'anthropic', extra: 'dropped' } as never],
  ...over,
});

describe('toOrgPlannerModelsDTO', () => {
  it('ready: four rows in order even when motir-ai answered fewer, missing ones following the platform', () => {
    const dto = toOrgPlannerModelsDTO(read(), true);
    expect(dto.state).toBe('ready');
    if (dto.state !== 'ready') return;
    expect(dto.canEdit).toBe(true);
    expect(dto.rows.map((r) => r.function)).toEqual([...ORG_PLANNER_FUNCTIONS]);
    expect(dto.rows[0]).toEqual({
      function: 'planning',
      model: null,
      withdrawn: false,
      applies: false,
      effectiveModel: null,
      effectiveSource: null,
      updatedAt: null,
    });
    expect(dto.rows[1]).toMatchObject({ model: 'm-guide', applies: true, effectiveSource: 'org' });
    expect(dto.offered).toEqual([{ id: 'm-guide', provider: 'anthropic' }]);
  });

  it('ready for a role that cannot edit carries canEdit: false', () => {
    expect(toOrgPlannerModelsDTO(read(), false).canEdit).toBe(false);
  });

  it('withdrawn is true only for a STORED model that is no longer offered', () => {
    const dto = toOrgPlannerModelsDTO(
      read({
        overrides: [
          {
            function: 'debug',
            model: 'm-gone',
            offered: false,
            applies: false,
            updatedAt: null,
            updatedByCoreUserId: null,
          },
          {
            function: 'ask',
            model: null,
            offered: false,
            applies: false,
            updatedAt: null,
            updatedByCoreUserId: null,
          },
        ],
      }),
      true,
    );
    if (dto.state !== 'ready') throw new Error('expected ready');
    expect(dto.rows.find((r) => r.function === 'debug')?.withdrawn).toBe(true);
    expect(dto.rows.find((r) => r.function === 'ask')?.withdrawn).toBe(false);
  });

  it('locked is built from scratch: exactly three keys, whatever motir-ai sent', () => {
    const locked = toOrgPlannerModelsDTO(
      read({ qualifies: false, extra: 'm-guide' } as never),
      true,
    );
    expect(locked).toEqual({ state: 'locked', canEdit: false, keptChoices: true });
    expect(JSON.stringify(locked)).not.toContain('m-guide');
    expect(toOrgPlannerModelsDTO(read({ qualifies: false, overrides: [] }), true)).toEqual({
      state: 'locked',
      canEdit: false,
      keptChoices: false,
    });
  });

  it('the unreadable answer carries no model and cannot edit', () => {
    expect(UNREADABLE_ORG_PLANNER_MODELS).toEqual({ state: 'unreadable', canEdit: false });
  });
});

describe('toOrgPlannerModelWriteDTO and isOrgPlannerFunction', () => {
  it('passes previous → new through, dropping anything else', () => {
    expect(
      toOrgPlannerModelWriteDTO({
        function: 'ask',
        previousModel: 'a',
        model: null,
        updatedAt: 't',
        extra: 1,
      } as never),
    ).toEqual({ function: 'ask', previousModel: 'a', model: null, updatedAt: 't' });
  });

  it('accepts the four functions only', () => {
    for (const fn of ORG_PLANNER_FUNCTIONS) expect(isOrgPlannerFunction(fn)).toBe(true);
    for (const v of ['review', 'Planning', '', 3, null])
      expect(isOrgPlannerFunction(v)).toBe(false);
  });
});
