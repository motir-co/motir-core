import { describe, expect, it } from 'vitest';
import type { PlannerModelSettingsRead, RunModelDefaultsRead } from '@/lib/ai/types';
import { toPlatformPlannerModelSettingsDTO } from '@/lib/mappers/platformPlannerModelMappers';
import { toPlatformRunModelDefaultsDTO } from '@/lib/mappers/platformRunModelDefaultsMappers';

// MOTIR-10844 — the two console mappers' changer names, pure. The service suites
// drive both end to end against the real database; these pin the two cases a
// real user row cannot reach there: a changer whose account has since been
// removed (no name at all), and one with no display name (their email).

const users = [{ id: 'u-named', name: '  ', email: 'ops@moooon.net' }];

describe('toPlatformPlannerModelSettingsDTO — function rows', () => {
  const read = (updatedByCoreUserId: string): PlannerModelSettingsRead => ({
    settings: [],
    offered: [],
    functions: [
      {
        function: 'ask',
        model: 'm',
        offered: true,
        updatedAt: '2026-11-10T00:00:00.000Z',
        updatedByCoreUserId,
      },
    ],
  });

  it('a blank name reads as the email; a removed account reads as no name, not seeded', () => {
    expect(
      toPlatformPlannerModelSettingsDTO(read('u-named'), users, true).functions[0],
    ).toMatchObject({ updatedBy: 'ops@moooon.net', seeded: false });
    expect(
      toPlatformPlannerModelSettingsDTO(read('u-gone'), users, true).functions[0],
    ).toMatchObject({ updatedBy: null, seeded: false });
  });
});

describe('toPlatformRunModelDefaultsDTO', () => {
  const read = (updatedByCoreUserId: string): RunModelDefaultsRead => ({
    settings: [
      {
        key: 'high',
        model: 'm',
        offered: true,
        effectiveModel: 'm',
        updatedAt: '2026-11-10T00:00:00.000Z',
        updatedByCoreUserId,
      },
    ],
    models: [],
  });
  const options = [{ id: 'm', provider: 'p' }];

  it('a blank name reads as the email; a removed account reads as no name, not seeded', () => {
    expect(
      toPlatformRunModelDefaultsDTO(read('u-named'), options, null, users, false).rows[0],
    ).toMatchObject({
      updatedBy: 'ops@moooon.net',
      updatedAt: '2026-11-10T00:00:00.000Z',
      seeded: false,
      withdrawn: false,
    });
    expect(
      toPlatformRunModelDefaultsDTO(read('u-gone'), options, null, users, false).rows[0],
    ).toMatchObject({
      updatedBy: null,
      seeded: false,
    });
  });
});
