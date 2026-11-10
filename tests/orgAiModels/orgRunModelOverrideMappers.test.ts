import { describe, expect, it } from 'vitest';
import { isOrgRunModelKey, ORG_RUN_MODEL_KEYS } from '@/lib/dto/orgAiModels';
import { resolveHostedModel, type HostedModelOffer } from '@/lib/hosted/resolveHostedModel';
import {
  toOrgRunModelRowDTO,
  toOrgRunModelsLockedDTO,
  toOrgRunModelsReadyDTO,
  UNREADABLE_ORG_RUN_MODELS,
} from '@/lib/mappers/orgAiModelsMappers';
import type { OrgHostedModelOverrideColumns } from '@/lib/repositories/organizationRepository';

// MOTIR-10850 — the org's six run-side columns + the run-model offer → the room's
// rows. Pure; the route suite drives the same mapper end to end. Every row that
// resolves to a model must agree with the shared rules a run uses.

const NONE: OrgHostedModelOverrideColumns = {
  hostedModelTrivial: null,
  hostedModelLow: null,
  hostedModelMedium: null,
  hostedModelHigh: null,
  hostedReviewModel: null,
  hostedDesignModel: null,
};

const offer = (over: Partial<HostedModelOffer> = {}): HostedModelOffer => ({
  models: ['m-a', 'm-b', 'm-c'],
  default: 'm-a',
  defaultsByDifficulty: { trivial: 'm-b', low: 'm-b', medium: 'm-a', high: null },
  reviewAgentDefault: 'm-b',
  designRunDefault: 'm-c',
  ...over,
});

describe('toOrgRunModelRowDTO', () => {
  it("a level's effective model is resolveHostedModel's answer with no project override", () => {
    const columns = { ...NONE, hostedModelLow: 'm-c' };
    for (const level of ['trivial', 'low', 'medium', 'high'] as const) {
      const resolved = resolveHostedModel({
        difficulty: level,
        overrides: { trivial: null, low: null, medium: null, high: null },
        offered: offer(),
        org: {
          levels: { trivial: null, low: 'm-c', medium: null, high: null },
          review: null,
          design: null,
        },
        design: false,
      });
      expect(toOrgRunModelRowDTO(level, columns, offer())).toMatchObject({
        effectiveModel: resolved?.model,
        effectiveSource: resolved?.source,
      });
    }
    expect(toOrgRunModelRowDTO('high', columns, offer())).toMatchObject({
      effectiveModel: 'm-a',
      effectiveSource: 'platform_default',
    });
  });

  it('review: org → reviewAgentDefault → default → first offered', () => {
    expect(toOrgRunModelRowDTO('review', { ...NONE, hostedReviewModel: 'm-c' }, offer())).toEqual({
      key: 'review',
      model: 'm-c',
      withdrawn: false,
      effectiveModel: 'm-c',
      effectiveSource: 'org_review',
    });
    expect(toOrgRunModelRowDTO('review', NONE, offer())).toMatchObject({
      effectiveModel: 'm-b',
      effectiveSource: 'platform_review',
    });
    expect(toOrgRunModelRowDTO('review', NONE, offer({ reviewAgentDefault: null }))).toMatchObject({
      effectiveModel: 'm-a',
      effectiveSource: 'platform_default',
    });
    expect(
      toOrgRunModelRowDTO('review', NONE, offer({ reviewAgentDefault: null, default: null })),
    ).toMatchObject({ effectiveModel: 'm-a', effectiveSource: 'first_offered' });
  });

  it('design: org → designRunDefault → no model, from the difficulty mapping', () => {
    expect(
      toOrgRunModelRowDTO('design', { ...NONE, hostedDesignModel: 'm-b' }, offer()),
    ).toMatchObject({ effectiveModel: 'm-b', effectiveSource: 'org_design' });
    expect(toOrgRunModelRowDTO('design', NONE, offer())).toMatchObject({
      effectiveModel: 'm-c',
      effectiveSource: 'platform_design',
    });
    expect(toOrgRunModelRowDTO('design', NONE, offer({ designRunDefault: null }))).toEqual({
      key: 'design',
      model: null,
      withdrawn: false,
      effectiveModel: null,
      effectiveSource: 'difficulty_mapping',
    });
  });

  it('withdrawn only for a stored value off the offer; the row then falls to the next layer', () => {
    expect(toOrgRunModelRowDTO('medium', { ...NONE, hostedModelMedium: 'gone' }, offer())).toEqual({
      key: 'medium',
      model: 'gone',
      withdrawn: true,
      effectiveModel: 'm-a',
      effectiveSource: 'platform_level',
    });
    expect(toOrgRunModelRowDTO('medium', NONE, offer()).withdrawn).toBe(false);
    expect(
      toOrgRunModelRowDTO('medium', { ...NONE, hostedModelMedium: 'm-b' }, offer()),
    ).toMatchObject({ withdrawn: false, effectiveSource: 'org_level' });
  });

  it('nothing offered answers no effective model for a level or the review', () => {
    const empty = offer({ models: [], default: null, reviewAgentDefault: null });
    expect(toOrgRunModelRowDTO('low', NONE, empty)).toMatchObject({
      effectiveModel: null,
      effectiveSource: null,
    });
    expect(toOrgRunModelRowDTO('review', NONE, empty)).toMatchObject({
      effectiveModel: null,
      effectiveSource: null,
    });
  });
});

describe('the three states', () => {
  it('ready: six rows in order, the offer trimmed to id and provider', () => {
    const dto = toOrgRunModelsReadyDTO(
      NONE,
      offer(),
      [{ id: 'm-a', provider: 'anthropic', extra: 1 } as never],
      true,
    );
    if (dto.state !== 'ready') throw new Error('expected ready');
    expect(dto.canEdit).toBe(true);
    expect(dto.rows.map((r) => r.key)).toEqual([...ORG_RUN_MODEL_KEYS]);
    expect(dto.offered).toEqual([{ id: 'm-a', provider: 'anthropic' }]);
  });

  it('locked is three keys whatever is stored, and names no model', () => {
    const locked = toOrgRunModelsLockedDTO({ ...NONE, hostedReviewModel: 'm-secret' });
    expect(locked).toEqual({ state: 'locked', canEdit: false, keptChoices: true });
    expect(JSON.stringify(locked)).not.toContain('m-secret');
    expect(toOrgRunModelsLockedDTO(NONE)).toEqual({
      state: 'locked',
      canEdit: false,
      keptChoices: false,
    });
  });

  it('unreadable carries no model and cannot edit', () => {
    expect(UNREADABLE_ORG_RUN_MODELS).toEqual({ state: 'unreadable', canEdit: false });
  });

  it('isOrgRunModelKey accepts the six keys only', () => {
    for (const key of ORG_RUN_MODEL_KEYS) expect(isOrgRunModelKey(key)).toBe(true);
    for (const v of ['guide', 'High', '', 1, null]) expect(isOrgRunModelKey(v)).toBe(false);
  });
});
