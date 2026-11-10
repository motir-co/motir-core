import { describe, expect, it } from 'vitest';
import {
  toHostedModelOverrideColumns,
  toProjectHostedAgentSettingsDto,
} from '@/lib/mappers/projectHostedAgentSettingsMappers';

// THE SETTINGS MAPPER (Story MOTIR-6989 · MOTIR-6997 coverage floor) — pure, so
// the two shapes the database-backed suites never reach are pinned here: a caller
// that holds only the offer (no providers), and an offer with nothing in it.

const NO_OVERRIDES = {
  hostedModelTrivial: null,
  hostedModelLow: null,
  hostedModelMedium: null,
  hostedModelHigh: null,
};
const NO_LEVELS = { trivial: null, low: null, medium: null, high: null };

describe('toProjectHostedAgentSettingsDto', () => {
  it('labels the bare offer with an empty provider when no provider list is passed', () => {
    const dto = toProjectHostedAgentSettingsDto(
      { ...NO_OVERRIDES, hostedModelHigh: 'm-2' },
      {
        models: ['m-1', 'm-2'],
        default: 'm-1',
        defaultsByDifficulty: NO_LEVELS,
        reviewAgentDefault: null,
        designRunDefault: null,
      },
    );
    expect(dto.offered).toEqual([
      { id: 'm-1', provider: '' },
      { id: 'm-2', provider: '' },
    ]);
    expect(dto.levels.find((l) => l.level === 'high')).toMatchObject({
      override: 'm-2',
      overrideOffered: true,
      effective: 'm-2',
      source: 'override',
    });
    expect(dto.noDifficulty).toEqual({ effective: 'm-1', source: 'platform_default' });
  });

  it('answers null effective models and sources when nothing is offered', () => {
    const dto = toProjectHostedAgentSettingsDto(
      { ...NO_OVERRIDES, hostedModelLow: 'm-gone' },
      {
        models: [],
        default: null,
        defaultsByDifficulty: NO_LEVELS,
        reviewAgentDefault: null,
        designRunDefault: null,
      },
    );
    expect(dto.offeredModels).toEqual([]);
    expect(dto.noDifficulty).toEqual({ effective: null, source: null });
    for (const level of dto.levels) {
      expect(level).toMatchObject({ effective: null, source: null, platformDefault: null });
    }
    expect(dto.levels.find((l) => l.level === 'low')).toMatchObject({
      override: 'm-gone',
      overrideOffered: false,
    });
  });
});

describe('toHostedModelOverrideColumns', () => {
  it('writes only the levels the patch names, a null as a reset', () => {
    expect(toHostedModelOverrideColumns({ trivial: 'a', medium: null })).toEqual({
      hostedModelTrivial: 'a',
      hostedModelMedium: null,
    });
    expect(toHostedModelOverrideColumns({})).toEqual({});
  });
});
