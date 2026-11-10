import { describe, expect, it } from 'vitest';
import {
  highestDifficulty,
  resolveHostedModel,
  type HostedModelOffer,
  type HostedModelsByDifficulty,
} from '@/lib/hosted/resolveHostedModel';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';

// THE RESOLVER (Story MOTIR-6989 · MOTIR-6993) — pure, so the whole precedence is
// walked here: every level × {override offered, override withdrawn, no override}
// × {level default offered, level default null}, plus a null difficulty and an
// empty offered list.

const OVERRIDE = 'model-override';
const WITHDRAWN = 'model-withdrawn';
const LEVEL = 'model-level';
const DEFAULT = 'model-default';
const FIRST = 'model-first';

const none = (): HostedModelsByDifficulty => ({
  trivial: null,
  low: null,
  medium: null,
  high: null,
});

function offerWith(levelDefault: string | null, level: keyof HostedModelsByDifficulty) {
  const defaultsByDifficulty = none();
  defaultsByDifficulty[level] = levelDefault;
  return {
    models: [FIRST, DEFAULT, LEVEL, OVERRIDE],
    default: DEFAULT,
    defaultsByDifficulty,
    reviewAgentDefault: null,
    designRunDefault: null,
  } satisfies HostedModelOffer;
}

type OverrideCase = 'offered' | 'withdrawn' | 'none';
const OVERRIDE_CASES: OverrideCase[] = ['offered', 'withdrawn', 'none'];

describe('resolveHostedModel — the precedence matrix', () => {
  for (const level of WORK_ITEM_DIFFICULTIES) {
    for (const overrideCase of OVERRIDE_CASES) {
      for (const levelDefault of [LEVEL, null]) {
        it(`${level}: override ${overrideCase}, level default ${levelDefault ?? 'null'}`, () => {
          const overrides = none();
          if (overrideCase === 'offered') overrides[level] = OVERRIDE;
          if (overrideCase === 'withdrawn') overrides[level] = WITHDRAWN;
          const result = resolveHostedModel({
            org: null,
            design: false,
            difficulty: level,
            overrides,
            offered: offerWith(levelDefault, level),
          });
          if (overrideCase === 'offered') {
            expect(result).toEqual({ model: OVERRIDE, source: 'override' });
          } else if (levelDefault !== null) {
            expect(result).toEqual({ model: LEVEL, source: 'platform_level' });
          } else {
            expect(result).toEqual({ model: DEFAULT, source: 'platform_default' });
          }
        });
      }
    }
  }

  it("reads only the card's own level — another level's override is ignored", () => {
    const overrides = { ...none(), high: OVERRIDE };
    expect(
      resolveHostedModel({
        org: null,
        design: false,
        difficulty: 'low',
        overrides,
        offered: offerWith(LEVEL, 'low'),
      }),
    ).toEqual({ model: LEVEL, source: 'platform_level' });
  });

  it('skips a level default motir-ai names but no longer offers', () => {
    const offered = { ...offerWith('gone', 'medium') };
    expect(
      resolveHostedModel({
        org: null,
        design: false,
        difficulty: 'medium',
        overrides: none(),
        offered,
      }),
    ).toEqual({
      model: DEFAULT,
      source: 'platform_default',
    });
  });

  it('falls to the first offered model when neither the level nor the default is offered', () => {
    const offered: HostedModelOffer = {
      models: [FIRST, OVERRIDE],
      default: null,
      defaultsByDifficulty: none(),
      reviewAgentDefault: null,
      designRunDefault: null,
    };
    expect(
      resolveHostedModel({
        org: null,
        design: false,
        difficulty: 'high',
        overrides: none(),
        offered,
      }),
    ).toEqual({
      model: FIRST,
      source: 'first_offered',
    });
  });
});

describe('resolveHostedModel — a card with no difficulty', () => {
  it('skips the override and the level default, and takes the platform default', () => {
    const overrides: HostedModelsByDifficulty = {
      trivial: OVERRIDE,
      low: OVERRIDE,
      medium: OVERRIDE,
      high: OVERRIDE,
    };
    const offered: HostedModelOffer = {
      models: [FIRST, DEFAULT, LEVEL, OVERRIDE],
      default: DEFAULT,
      defaultsByDifficulty: { trivial: LEVEL, low: LEVEL, medium: LEVEL, high: LEVEL },
      reviewAgentDefault: null,
      designRunDefault: null,
    };
    expect(
      resolveHostedModel({ org: null, design: false, difficulty: null, overrides, offered }),
    ).toEqual({
      model: DEFAULT,
      source: 'platform_default',
    });
  });

  it('takes the first offered model when there is no platform default', () => {
    const offered: HostedModelOffer = {
      models: [FIRST],
      default: null,
      defaultsByDifficulty: none(),
      reviewAgentDefault: null,
      designRunDefault: null,
    };
    expect(
      resolveHostedModel({
        org: null,
        design: false,
        difficulty: null,
        overrides: none(),
        offered,
      }),
    ).toEqual({
      model: FIRST,
      source: 'first_offered',
    });
  });
});

describe('resolveHostedModel — nothing offered', () => {
  it('answers null for every level and for no difficulty, whatever is configured', () => {
    const offered: HostedModelOffer = {
      models: [],
      default: DEFAULT,
      defaultsByDifficulty: { trivial: LEVEL, low: LEVEL, medium: LEVEL, high: LEVEL },
      reviewAgentDefault: null,
      designRunDefault: null,
    };
    const overrides = { ...none(), low: OVERRIDE };
    for (const difficulty of [...WORK_ITEM_DIFFICULTIES, null]) {
      expect(
        resolveHostedModel({ org: null, design: false, difficulty, overrides, offered }),
      ).toBeNull();
    }
  });
});

describe('highestDifficulty', () => {
  it('answers the hardest level present', () => {
    expect(highestDifficulty(['low', 'high', 'trivial'], WORK_ITEM_DIFFICULTIES)).toBe('high');
    expect(highestDifficulty(['low', 'medium'], WORK_ITEM_DIFFICULTIES)).toBe('medium');
  });

  it('ignores leaves with no difficulty', () => {
    expect(highestDifficulty([null, 'trivial', null], WORK_ITEM_DIFFICULTIES)).toBe('trivial');
  });

  it('answers null when no leaf carries a difficulty, or there are no leaves', () => {
    expect(highestDifficulty([null, null], WORK_ITEM_DIFFICULTIES)).toBeNull();
    expect(highestDifficulty([], WORK_ITEM_DIFFICULTIES)).toBeNull();
  });
});
