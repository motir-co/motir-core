import { describe, expect, it } from 'vitest';
import { orgQualifiesForHostedModelChoice } from '@/lib/billing/modelChoiceQualification';
import {
  isDesignRun,
  resolveHostedModel,
  resolveReviewModel,
  type HostedModelOffer,
  type HostedModelsByDifficulty,
  type OrgHostedModelLayer,
} from '@/lib/hosted/resolveHostedModel';

// THE ORGANISATION AND DESIGN LAYERS OF THE RESOLVER (story MOTIR-10838 ·
// MOTIR-10843) — pure, so every new step of the precedence is walked here: the
// design branch (org design → platform design) ahead of the project override, the
// org's per-level default between the project override and the platform level,
// a withdrawn org value skipped at its layer, the review model's own two-step
// rule, which cards are design runs, and which tiers qualify.

const none = (): HostedModelsByDifficulty => ({
  trivial: null,
  low: null,
  medium: null,
  high: null,
});

const ORG_DESIGN = 'm-org-design';
const PLATFORM_DESIGN = 'm-platform-design';
const OVERRIDE = 'm-override';
const ORG_LEVEL = 'm-org-level';
const PLATFORM_LEVEL = 'm-platform-level';
const DEFAULT = 'm-default';
const ORG_REVIEW = 'm-org-review';
const PLATFORM_REVIEW = 'm-platform-review';

const offer = (over: Partial<HostedModelOffer> = {}): HostedModelOffer => ({
  models: [
    DEFAULT,
    ORG_DESIGN,
    PLATFORM_DESIGN,
    OVERRIDE,
    ORG_LEVEL,
    PLATFORM_LEVEL,
    ORG_REVIEW,
    PLATFORM_REVIEW,
  ],
  default: DEFAULT,
  defaultsByDifficulty: { ...none(), high: PLATFORM_LEVEL },
  reviewAgentDefault: PLATFORM_REVIEW,
  designRunDefault: PLATFORM_DESIGN,
  ...over,
});

const org = (over: Partial<OrgHostedModelLayer> = {}): OrgHostedModelLayer => ({
  levels: { ...none(), high: ORG_LEVEL },
  review: ORG_REVIEW,
  design: ORG_DESIGN,
  ...over,
});

const full = { ...none(), high: OVERRIDE };

describe('resolveHostedModel — the design branch', () => {
  it('a design run takes the org design-run model ahead of the project override', () => {
    expect(
      resolveHostedModel({
        difficulty: 'high',
        overrides: full,
        offered: offer(),
        org: org(),
        design: true,
      }),
    ).toEqual({ model: ORG_DESIGN, source: 'org_design' });
  });

  it('then the platform design-run model when the org has none, or does not qualify', () => {
    for (const layer of [org({ design: null }), null]) {
      expect(
        resolveHostedModel({
          difficulty: 'high',
          overrides: full,
          offered: offer(),
          org: layer,
          design: true,
        }),
      ).toEqual({ model: PLATFORM_DESIGN, source: 'platform_design' });
    }
  });

  it('a withdrawn org design model is skipped at its layer', () => {
    expect(
      resolveHostedModel({
        difficulty: null,
        overrides: none(),
        offered: offer(),
        org: org({ design: 'm-gone' }),
        design: true,
      }),
    ).toEqual({ model: PLATFORM_DESIGN, source: 'platform_design' });
  });

  it('a design run with neither design model falls through to the difficulty rule', () => {
    expect(
      resolveHostedModel({
        difficulty: 'high',
        overrides: full,
        offered: offer({ designRunDefault: null }),
        org: org({ design: null }),
        design: true,
      }),
    ).toEqual({ model: OVERRIDE, source: 'override' });
  });

  it('a card that is not a design run never reads either design model', () => {
    expect(
      resolveHostedModel({
        difficulty: null,
        overrides: none(),
        offered: offer(),
        org: org(),
        design: false,
      }),
    ).toEqual({ model: DEFAULT, source: 'platform_default' });
  });
});

describe('resolveHostedModel — the org per-level default', () => {
  it('the project override still wins over the org default', () => {
    expect(
      resolveHostedModel({
        difficulty: 'high',
        overrides: full,
        offered: offer(),
        org: org(),
        design: false,
      }),
    ).toEqual({ model: OVERRIDE, source: 'override' });
  });

  it('with no project override the org default wins over the platform level', () => {
    expect(
      resolveHostedModel({
        difficulty: 'high',
        overrides: none(),
        offered: offer(),
        org: org(),
        design: false,
      }),
    ).toEqual({ model: ORG_LEVEL, source: 'org_level' });
  });

  it('a withdrawn org default, another level, or no org layer reads the platform level', () => {
    for (const layer of [
      org({ levels: { ...none(), high: 'm-gone' } }),
      org({ levels: { ...none(), low: ORG_LEVEL } }),
      null,
    ]) {
      expect(
        resolveHostedModel({
          difficulty: 'high',
          overrides: none(),
          offered: offer(),
          org: layer,
          design: false,
        }),
      ).toEqual({ model: PLATFORM_LEVEL, source: 'platform_level' });
    }
  });

  it('a card with no difficulty skips the org level entirely', () => {
    expect(
      resolveHostedModel({
        difficulty: null,
        overrides: none(),
        offered: offer(),
        org: org(),
        design: false,
      }),
    ).toEqual({ model: DEFAULT, source: 'platform_default' });
  });
});

describe('resolveReviewModel', () => {
  it('the org review model first, then the platform review model', () => {
    expect(resolveReviewModel(offer(), org())).toEqual({ model: ORG_REVIEW, source: 'org_review' });
    expect(resolveReviewModel(offer(), org({ review: null }))).toEqual({
      model: PLATFORM_REVIEW,
      source: 'platform_review',
    });
    expect(resolveReviewModel(offer(), null)).toEqual({
      model: PLATFORM_REVIEW,
      source: 'platform_review',
    });
  });

  it('skips a withdrawn value at each layer, answering null when neither is offered', () => {
    expect(resolveReviewModel(offer(), org({ review: 'm-gone' }))).toEqual({
      model: PLATFORM_REVIEW,
      source: 'platform_review',
    });
    expect(
      resolveReviewModel(offer({ reviewAgentDefault: 'm-gone' }), org({ review: 'm-gone' })),
    ).toBeNull();
    expect(resolveReviewModel(offer({ reviewAgentDefault: null }), null)).toBeNull();
  });
});

describe('isDesignRun', () => {
  it('true only when there is at least one unfinished leaf and every one is a design card', () => {
    expect(isDesignRun([{ type: 'design' }])).toBe(true);
    expect(isDesignRun([{ type: 'design' }, { type: 'design' }])).toBe(true);
    expect(isDesignRun([{ type: 'design' }, { type: 'code' }])).toBe(false);
    expect(isDesignRun([{ type: null }])).toBe(false);
    expect(isDesignRun([])).toBe(false);
  });
});

describe('orgQualifiesForHostedModelChoice', () => {
  it('the meta org always qualifies, whatever the tier', () => {
    expect(orgQualifiesForHostedModelChoice({ isMeta: true, tierKey: null })).toBe(true);
    expect(orgQualifiesForHostedModelChoice({ isMeta: true, tierKey: 'free' })).toBe(true);
  });

  it('a paid tier above standard qualifies; free, standard, empty and unknown do not', () => {
    for (const tierKey of ['pro', 'team', 'enterprise']) {
      expect(orgQualifiesForHostedModelChoice({ isMeta: false, tierKey })).toBe(true);
    }
    for (const tierKey of ['free', 'standard', '', null]) {
      expect(orgQualifiesForHostedModelChoice({ isMeta: false, tierKey })).toBe(false);
    }
  });
});
